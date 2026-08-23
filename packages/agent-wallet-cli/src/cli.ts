import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentWalletError,
  AttemptStore,
  asAgentWalletError,
  authorizePayment,
  backupWallet,
  createWallet,
  defaultDataRoot,
  importWallet,
  listWallets,
  readWalletBalance,
  readWalletMetadata,
  requestRefillNotification,
  retireWallet,
  submitAuthorizedPayment,
  walletPaths,
  type RpcConfiguration,
  type RefillReason,
  type SupportedNetwork,
} from "@x402api/agent-wallet-core";

type Io = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  readStdin: () => Promise<string>;
};

type ParsedArguments = {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
};

const HELP = {
  version: 1,
  binary: "x402api",
  commands: [
    "wallet create --name <name> --network <network>",
    "wallet list",
    "wallet show --wallet <name>",
    "wallet address --wallet <name>",
    "wallet balance --wallet <name>",
    "wallet notify-refill --wallet <name> --subscription-reference <id> --renew-by <UTC> --target-balance-atomic <amount> --reason <renewal|low_balance>",
    "wallet backup --wallet <name> --output <file>",
    "wallet import --name <name> --input <file>",
    "wallet retire --wallet <name> --confirm <name>",
    "wallet sweep --wallet <name> --to <address>",
    "payment authorize --wallet <name> --request-envelope <file> --artifact-out <file>",
    "payment submit --attempt <id> --request-envelope <file>",
    "payment status --attempt <id>",
    "payment artifact --attempt <id> --output <file>",
    "payment abandon --attempt <id>",
    "payment reconcile --attempt <id> --request-envelope <file>",
    "pay --wallet <name> --request-envelope <file> --artifact-out <file>",
    "skill install --output <directory>",
  ],
  passwordSources: ["--password-stdin", "X402API_WALLET_PASSWORD_FILE"],
  rpcEnvironment: [
    "X402API_BASE_RPC_URL",
    "X402API_SOLANA_RPC_URL",
    "X402API_TRON_RPC_URL",
  ],
  notificationEnvironment: ["X402API_NOTIFICATION_URL"],
};

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleanFlags = new Set(["json", "password-stdin"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      values.has(name) ||
      flags.has(name)
    ) {
      throw new AgentWalletError(
        "invalid_input",
        `invalid or duplicate option: ${value}`,
      );
    }
    if (booleanFlags.has(name)) {
      flags.add(name);
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new AgentWalletError(
        "invalid_input",
        `option requires a value: ${value}`,
      );
    }
    values.set(name, optionValue);
    index += 1;
  }
  return { positionals, values, flags };
}

function required(parsed: ParsedArguments, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.length === 0) {
    throw new AgentWalletError("invalid_input", `--${name} is required`);
  }
  return value;
}

function rejectUnknown(
  parsed: ParsedArguments,
  allowedValues: readonly string[],
  allowedFlags: readonly string[] = ["json"],
): void {
  for (const name of parsed.values.keys()) {
    if (!allowedValues.includes(name)) {
      throw new AgentWalletError("invalid_input", `unknown option: --${name}`);
    }
  }
  for (const name of parsed.flags) {
    if (!allowedFlags.includes(name)) {
      throw new AgentWalletError("invalid_input", `unknown flag: --${name}`);
    }
  }
}

async function readPasswordFile(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new AgentWalletError(
        "password_required",
        "wallet password file was not found",
      );
    }
    throw error;
  });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 12 ||
    stat.size > 4096 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      "wallet password file must be an owner-only regular file",
    );
  }
  return readFile(absolute, "utf8");
}

function normalizePassphrase(value: string): string {
  const normalized = value.replace(/\r?\n$/, "");
  if (normalized.includes("\n") || normalized.includes("\r")) {
    throw new AgentWalletError(
      "password_required",
      "wallet passphrase must be one line",
    );
  }
  return normalized;
}

async function passphrase(
  parsed: ParsedArguments,
  io: Io,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const passwordFile = environment.X402API_WALLET_PASSWORD_FILE;
  if (parsed.flags.has("password-stdin") && passwordFile) {
    throw new AgentWalletError(
      "password_required",
      "configure exactly one wallet password source",
    );
  }
  if (parsed.flags.has("password-stdin"))
    return normalizePassphrase(await io.readStdin());
  if (passwordFile)
    return normalizePassphrase(await readPasswordFile(passwordFile));
  throw new AgentWalletError(
    "password_required",
    "use --password-stdin or X402API_WALLET_PASSWORD_FILE",
  );
}

function rpcConfiguration(environment: NodeJS.ProcessEnv): RpcConfiguration {
  return {
    ...(environment.X402API_BASE_RPC_URL
      ? { base: environment.X402API_BASE_RPC_URL }
      : {}),
    ...(environment.X402API_SOLANA_RPC_URL
      ? { solana: environment.X402API_SOLANA_RPC_URL }
      : {}),
    ...(environment.X402API_TRON_RPC_URL
      ? { tron: environment.X402API_TRON_RPC_URL }
      : {}),
  };
}

function publicWallet(
  metadata: Awaited<ReturnType<typeof readWalletMetadata>>,
) {
  return {
    version: metadata.version,
    wallet: metadata.name,
    network: metadata.network,
    address: metadata.address,
    createdAt: metadata.createdAt,
    ...(metadata.maximumPaymentAtomic === undefined
      ? {}
      : { maximumPaymentAtomic: metadata.maximumPaymentAtomic }),
    ...(metadata.retiredAt === undefined
      ? {}
      : { retiredAt: metadata.retiredAt }),
  };
}

async function skillSourceDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../skill"),
    resolve(moduleDirectory, "../../../skills/x402api-pay"),
  ];
  for (const candidate of candidates) {
    const stat = await lstat(join(candidate, "SKILL.md")).catch(
      () => undefined,
    );
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  throw new AgentWalletError(
    "operation_not_supported",
    "the x402api-pay skill is missing from this CLI installation",
  );
}

async function installSkill(output: string): Promise<string> {
  const destination = resolve(output);
  const existing = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing !== undefined) {
    throw new AgentWalletError(
      "invalid_input",
      "skill output already exists; choose a new directory or remove it explicitly",
    );
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".x402api-pay-"));
  try {
    const stagedSkill = join(staging, "x402api-pay");
    await cp(await skillSourceDirectory(), stagedSkill, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await rename(stagedSkill, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return destination;
}

async function dispatch(
  parsed: ParsedArguments,
  io: Io,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const [group, action] = parsed.positionals;
  if (group === "help" || group === "--help" || group === undefined) {
    rejectUnknown(parsed, [], ["json"]);
    return HELP;
  }
  if (group === "skill" && action === "install") {
    rejectUnknown(parsed, ["output"]);
    return {
      version: 1,
      status: "installed",
      skillPath: await installSkill(required(parsed, "output")),
    };
  }
  const paths = walletPaths(defaultDataRoot(environment));
  if (group === "wallet" && action === "create") {
    rejectUnknown(
      parsed,
      ["name", "network", "maximum-payment-atomic"],
      ["json", "password-stdin"],
    );
    const network = required(parsed, "network") as SupportedNetwork;
    const metadata = await createWallet({
      walletsDirectory: paths.wallets,
      name: required(parsed, "name"),
      network,
      passphrase: await passphrase(parsed, io, environment),
      ...(parsed.values.has("maximum-payment-atomic")
        ? { maximumPaymentAtomic: required(parsed, "maximum-payment-atomic") }
        : {}),
    });
    return {
      ...publicWallet(metadata),
      storage: "local-encrypted-keystore",
      status: "created_unfunded",
    };
  }
  if (group === "wallet" && action === "list") {
    rejectUnknown(parsed, []);
    return {
      version: 1,
      wallets: (await listWallets(paths.wallets)).map(publicWallet),
    };
  }
  if (group === "wallet" && ["show", "address"].includes(action ?? "")) {
    rejectUnknown(parsed, ["wallet"]);
    return publicWallet(
      await readWalletMetadata(paths.wallets, required(parsed, "wallet")),
    );
  }
  if (group === "wallet" && action === "balance") {
    rejectUnknown(parsed, ["wallet"]);
    const metadata = await readWalletMetadata(
      paths.wallets,
      required(parsed, "wallet"),
    );
    return readWalletBalance({
      network: metadata.network,
      address: metadata.address,
      rpc: rpcConfiguration(environment),
    });
  }
  if (group === "wallet" && action === "notify-refill") {
    rejectUnknown(
      parsed,
      [
        "wallet",
        "subscription-reference",
        "renew-by",
        "target-balance-atomic",
        "reason",
      ],
      ["json", "password-stdin"],
    );
    const notificationUrl = environment.X402API_NOTIFICATION_URL;
    if (!notificationUrl) {
      throw new AgentWalletError(
        "notification_not_configured",
        "X402API_NOTIFICATION_URL is required",
      );
    }
    return requestRefillNotification({
      walletsDirectory: paths.wallets,
      wallet: required(parsed, "wallet"),
      passphrase: await passphrase(parsed, io, environment),
      rpc: rpcConfiguration(environment),
      notificationUrl,
      subscriptionReference: required(parsed, "subscription-reference"),
      renewBy: required(parsed, "renew-by"),
      targetBalanceAtomic: required(parsed, "target-balance-atomic"),
      reason: required(parsed, "reason") as RefillReason,
    });
  }
  if (group === "wallet" && action === "backup") {
    rejectUnknown(parsed, ["wallet", "output"]);
    const output = await backupWallet({
      walletsDirectory: paths.wallets,
      name: required(parsed, "wallet"),
      output: required(parsed, "output"),
    });
    return {
      version: 1,
      wallet: required(parsed, "wallet"),
      backupPath: output,
    };
  }
  if (group === "wallet" && action === "import") {
    rejectUnknown(parsed, ["name", "input"], ["json", "password-stdin"]);
    const metadata = await importWallet({
      walletsDirectory: paths.wallets,
      name: required(parsed, "name"),
      input: required(parsed, "input"),
      passphrase: await passphrase(parsed, io, environment),
    });
    return { ...publicWallet(metadata), status: "imported" };
  }
  if (group === "wallet" && action === "retire") {
    rejectUnknown(parsed, ["wallet", "confirm"], ["json", "password-stdin"]);
    const wallet = required(parsed, "wallet");
    const active = await new AttemptStore(paths.attempts).activeForWallet(
      wallet,
    );
    if (active.length > 0) {
      throw new AgentWalletError(
        "attempt_ambiguous",
        "wallet has non-terminal payment attempts and cannot be retired",
        { details: { attemptIds: active.map((record) => record.attemptId) } },
      );
    }
    const metadata = await retireWallet({
      walletsDirectory: paths.wallets,
      name: wallet,
      passphrase: await passphrase(parsed, io, environment),
      confirmation: required(parsed, "confirm"),
    });
    return { ...publicWallet(metadata), status: "retired" };
  }
  if (group === "wallet" && action === "sweep") {
    rejectUnknown(parsed, ["wallet", "to"]);
    throw new AgentWalletError(
      "operation_not_supported",
      "sweep is release-gated until per-rail fee and destination conformance tests pass",
    );
  }
  if (group === "payment" && action === "authorize") {
    rejectUnknown(
      parsed,
      ["wallet", "request-envelope", "artifact-out"],
      ["json", "password-stdin"],
    );
    return authorizePayment({
      walletsDirectory: paths.wallets,
      attemptsDirectory: paths.attempts,
      wallet: required(parsed, "wallet"),
      passphrase: await passphrase(parsed, io, environment),
      requestEnvelopePath: required(parsed, "request-envelope"),
      artifactPath: required(parsed, "artifact-out"),
      rpc: rpcConfiguration(environment),
    });
  }
  if (group === "payment" && action === "status") {
    rejectUnknown(parsed, ["attempt"]);
    return new AttemptStore(paths.attempts).get(required(parsed, "attempt"));
  }
  if (group === "payment" && (action === "submit" || action === "reconcile")) {
    rejectUnknown(parsed, ["attempt", "request-envelope"]);
    return submitAuthorizedPayment({
      attemptsDirectory: paths.attempts,
      attemptId: required(parsed, "attempt"),
      requestEnvelopePath: required(parsed, "request-envelope"),
    });
  }
  if (group === "payment" && action === "artifact") {
    rejectUnknown(parsed, ["attempt", "output"]);
    const attempt = required(parsed, "attempt");
    const output = await new AttemptStore(paths.attempts).copyArtifact(
      attempt,
      required(parsed, "output"),
    );
    return { version: 1, attemptId: attempt, artifactPath: output };
  }
  if (group === "payment" && action === "abandon") {
    rejectUnknown(parsed, ["attempt"]);
    const attempt = required(parsed, "attempt");
    const store = new AttemptStore(paths.attempts);
    const record = await store.abandon(attempt);
    return {
      version: 1,
      attemptId: attempt,
      state: record.state,
      warning:
        "Local abandonment cannot reverse an authorization or settlement.",
    };
  }
  if (group === "pay") {
    rejectUnknown(
      parsed,
      ["wallet", "request-envelope", "artifact-out"],
      ["json", "password-stdin"],
    );
    const requestEnvelopePath = required(parsed, "request-envelope");
    const authorization = await authorizePayment({
      walletsDirectory: paths.wallets,
      attemptsDirectory: paths.attempts,
      wallet: required(parsed, "wallet"),
      passphrase: await passphrase(parsed, io, environment),
      requestEnvelopePath,
      artifactPath: required(parsed, "artifact-out"),
      rpc: rpcConfiguration(environment),
    });
    return submitAuthorizedPayment({
      attemptsDirectory: paths.attempts,
      attemptId: authorization.attemptId,
      requestEnvelopePath,
    });
  }
  throw new AgentWalletError("invalid_input", "unknown x402api command");
}

export async function runCli(
  args: string[],
  options: {
    io?: Io;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const io: Io = options.io ?? {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (chunks.reduce((size, item) => size + item.length, 0) > 4096) {
          throw new AgentWalletError(
            "password_required",
            "wallet passphrase input is too large",
          );
        }
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
  let parsed: ParsedArguments | undefined;
  try {
    parsed = parseArguments(args);
    if (!parsed.flags.has("json")) {
      throw new AgentWalletError(
        "invalid_input",
        "--json is required for the V1 CLI contract",
      );
    }
    const result = await dispatch(
      parsed,
      io,
      options.environment ?? process.env,
    );
    io.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const normalized = asAgentWalletError(error);
    const payload = {
      version: 1,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        ...(normalized.details === undefined
          ? {}
          : { details: normalized.details }),
      },
    };
    if (parsed?.flags.has("json") ?? args.includes("--json")) {
      io.stdout(`${JSON.stringify(payload)}\n`);
    } else {
      io.stderr(`${normalized.code}: ${normalized.message}\n`);
    }
    return normalized.exitCode;
  }
}
