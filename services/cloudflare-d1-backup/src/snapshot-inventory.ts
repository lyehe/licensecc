import { createHash } from "node:crypto";

export interface BackupSnapshotInventory {
  algorithm: "d1-export-sql-insert-count-v1";
  /** Names and row counts only; no exported values are retained or logged. */
  table_counts: Record<string, number>;
}

// Keep this inventory in lockstep with restore-drill.mjs REQUIRED_TABLES. The
// backup-local test suite compares the two exported constants so drift fails
// before a deployment. High-churn/ephemeral tables remain schema-only checks.
export const SNAPSHOT_COUNTED_TABLES = [
  "entitlements",
  "entitlement_events",
  "mutation_idempotency",
  "customers",
  "licenses",
  "entitlement_devices",
  "orders",
  "order_events",
  "account_tokens",
  "account_token_revocations",
  "account_token_events",
  "customer_events",
  "entitlement_policies",
  "policy_events",
  "webhook_endpoints",
  "audit_digests",
  "catalog_features",
  "catalog_plans",
  "catalog_plan_features",
  "license_plan_assignments",
  "catalog_events",
  "webhook_events",
  "license_plan_assignment_events",
] as const;

const SNAPSHOT_COUNTED_TABLE_SET = new Set<string>(SNAPSHOT_COUNTED_TABLES);
type SqlTokenKind = "word" | "identifier" | "string" | "punctuation";

class SnapshotInventoryInterpreter {
  private readonly createdTables = new Set<string>();
  private readonly insertedTables = new Set<string>();
  private readonly counts = new Map<string, number>();
  private phase:
    | "start"
    | "create_after_create"
    | "create_after_table"
    | "create_after_if"
    | "create_after_not"
    | "create_done"
    | "insert_seek_into"
    | "insert_table"
    | "insert_seek_values"
    | "insert_values"
    | "ignored" = "start";
  private currentInsertTable: string | undefined;
  private insertHeaderDepth = 0;
  private insertValueDepth = 0;
  private insertRowCount = 0;
  private insertPrefixTokens = 0;

  token(kind: SqlTokenKind, rawValue = ""): void {
    if (kind === "punctuation" && rawValue === ";") {
      this.endStatement();
      return;
    }
    const value = rawValue.toLowerCase();
    switch (this.phase) {
      case "start":
        if (kind === "word" && value === "create") {
          this.phase = "create_after_create";
        } else if (kind === "word" && value === "insert") {
          this.phase = "insert_seek_into";
        } else {
          this.phase = "ignored";
        }
        break;
      case "create_after_create":
        this.phase = kind === "word" && value === "table" ? "create_after_table" : "ignored";
        break;
      case "create_after_table":
        if (kind === "word" && value === "if") {
          this.phase = "create_after_if";
        } else {
          this.recordCreatedTable(kind, value);
        }
        break;
      case "create_after_if":
        this.phase = kind === "word" && value === "not" ? "create_after_not" : "ignored";
        break;
      case "create_after_not":
        this.phase = kind === "word" && value === "exists" ? "create_after_table" : "ignored";
        break;
      case "insert_seek_into":
        this.insertPrefixTokens += 1;
        if (kind === "word" && value === "into") {
          this.phase = "insert_table";
        } else if (this.insertPrefixTokens > 4) {
          this.phase = "ignored";
        }
        break;
      case "insert_table":
        if (kind === "word" || kind === "identifier") {
          this.currentInsertTable = value;
          this.phase = "insert_seek_values";
        } else {
          this.phase = "ignored";
        }
        break;
      case "insert_seek_values":
        if (kind === "punctuation" && rawValue === "(") {
          this.insertHeaderDepth += 1;
        } else if (kind === "punctuation" && rawValue === ")") {
          if (this.insertHeaderDepth < 1) {
            this.phase = "ignored";
          } else {
            this.insertHeaderDepth -= 1;
          }
        } else if (kind === "word" && value === "values" && this.insertHeaderDepth === 0) {
          this.phase = "insert_values";
        } else if (kind === "word" && value === "select" && this.insertHeaderDepth === 0) {
          this.phase = "ignored";
        }
        break;
      case "insert_values":
        if (kind === "punctuation" && rawValue === "(") {
          if (this.insertValueDepth === 0) {
            this.insertRowCount += 1;
            if (!Number.isSafeInteger(this.insertRowCount)) {
              throw new Error("snapshot_inventory_count_overflow");
            }
          }
          this.insertValueDepth += 1;
        } else if (kind === "punctuation" && rawValue === ")") {
          if (this.insertValueDepth < 1) {
            this.phase = "ignored";
          } else {
            this.insertValueDepth -= 1;
          }
        }
        break;
      case "create_done":
      case "ignored":
        break;
    }
  }

  private recordCreatedTable(kind: SqlTokenKind, table: string): void {
    if (kind !== "word" && kind !== "identifier") {
      this.phase = "ignored";
      return;
    }
    if (SNAPSHOT_COUNTED_TABLE_SET.has(table)) {
      if (this.createdTables.has(table)) {
        throw new Error("snapshot_inventory_duplicate_table_definition");
      }
      this.createdTables.add(table);
      this.counts.set(table, 0);
    }
    this.phase = "create_done";
  }

  private endStatement(): void {
    if (this.currentInsertTable !== undefined && SNAPSHOT_COUNTED_TABLE_SET.has(this.currentInsertTable)) {
      if (this.phase !== "insert_values" || this.insertValueDepth !== 0 || this.insertRowCount < 1) {
        throw new Error("snapshot_inventory_unsupported_insert");
      }
      const prior = this.counts.get(this.currentInsertTable) ?? 0;
      const next = prior + this.insertRowCount;
      if (!Number.isSafeInteger(next)) {
        throw new Error("snapshot_inventory_count_overflow");
      }
      this.counts.set(this.currentInsertTable, next);
      this.insertedTables.add(this.currentInsertTable);
    }
    this.resetStatement();
  }

  private resetStatement(): void {
    this.phase = "start";
    this.currentInsertTable = undefined;
    this.insertHeaderDepth = 0;
    this.insertValueDepth = 0;
    this.insertRowCount = 0;
    this.insertPrefixTokens = 0;
  }

  finish(): BackupSnapshotInventory {
    if (this.phase !== "start") {
      this.endStatement();
    }
    for (const table of this.insertedTables) {
      if (!this.createdTables.has(table)) {
        throw new Error("snapshot_inventory_table_definition_missing");
      }
    }
    const tableCounts: Record<string, number> = {};
    for (const table of SNAPSHOT_COUNTED_TABLES) {
      const count = this.counts.get(table);
      if (count !== undefined) {
        tableCounts[table] = count;
      }
    }
    return {
      algorithm: "d1-export-sql-insert-count-v1",
      table_counts: tableCounts,
    };
  }
}

class StreamingSqlTokenizer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly interpreter = new SnapshotInventoryInterpreter();
  private mode:
    | "normal"
    | "dash"
    | "slash"
    | "line_comment"
    | "block_comment"
    | "block_comment_star"
    | "single_quote"
    | "single_quote_end"
    | "double_quote"
    | "double_quote_end"
    | "backtick"
    | "backtick_end"
    | "bracket" = "normal";
  private word = "";
  private quotedIdentifier = "";

  write(chunk: Uint8Array): void {
    this.writeText(this.decoder.decode(chunk, { stream: true }));
  }

  private writeText(text: string): void {
    for (const character of text) {
      this.writeCharacter(character);
    }
  }

  private appendWord(character: string): void {
    if (this.word.length < 256) {
      this.word += character;
    }
  }

  private appendQuotedIdentifier(character: string): void {
    if (this.quotedIdentifier.length < 256) {
      this.quotedIdentifier += character;
    }
  }

  private flushWord(): void {
    if (this.word !== "") {
      this.interpreter.token("word", this.word);
      this.word = "";
    }
  }

  private flushQuotedIdentifier(): void {
    this.interpreter.token("identifier", this.quotedIdentifier);
    this.quotedIdentifier = "";
  }

  private writeCharacter(character: string): void {
    let reprocess = true;
    while (reprocess) {
      reprocess = false;
      switch (this.mode) {
        case "normal":
          if (/^[A-Za-z0-9_$]$/.test(character)) {
            this.appendWord(character);
          } else {
            this.flushWord();
            if (/^\s$/.test(character)) {
              break;
            }
            if (character === "-") {
              this.mode = "dash";
            } else if (character === "/") {
              this.mode = "slash";
            } else if (character === "'") {
              this.mode = "single_quote";
            } else if (character === '"') {
              this.quotedIdentifier = "";
              this.mode = "double_quote";
            } else if (character === "`") {
              this.quotedIdentifier = "";
              this.mode = "backtick";
            } else if (character === "[") {
              this.quotedIdentifier = "";
              this.mode = "bracket";
            } else {
              this.interpreter.token("punctuation", character);
            }
          }
          break;
        case "dash":
          if (character === "-") {
            this.mode = "line_comment";
          } else {
            this.interpreter.token("punctuation", "-");
            this.mode = "normal";
            reprocess = true;
          }
          break;
        case "slash":
          if (character === "*") {
            this.mode = "block_comment";
          } else {
            this.interpreter.token("punctuation", "/");
            this.mode = "normal";
            reprocess = true;
          }
          break;
        case "line_comment":
          if (character === "\n" || character === "\r") {
            this.mode = "normal";
          }
          break;
        case "block_comment":
          if (character === "*") {
            this.mode = "block_comment_star";
          }
          break;
        case "block_comment_star":
          if (character === "/") {
            this.mode = "normal";
          } else if (character !== "*") {
            this.mode = "block_comment";
          }
          break;
        case "single_quote":
          if (character === "'") {
            this.mode = "single_quote_end";
          }
          break;
        case "single_quote_end":
          if (character === "'") {
            this.mode = "single_quote";
          } else {
            this.interpreter.token("string");
            this.mode = "normal";
            reprocess = true;
          }
          break;
        case "double_quote":
          if (character === '"') {
            this.mode = "double_quote_end";
          } else {
            this.appendQuotedIdentifier(character);
          }
          break;
        case "double_quote_end":
          if (character === '"') {
            this.appendQuotedIdentifier(character);
            this.mode = "double_quote";
          } else {
            this.flushQuotedIdentifier();
            this.mode = "normal";
            reprocess = true;
          }
          break;
        case "backtick":
          if (character === "`") {
            this.mode = "backtick_end";
          } else {
            this.appendQuotedIdentifier(character);
          }
          break;
        case "backtick_end":
          if (character === "`") {
            this.appendQuotedIdentifier(character);
            this.mode = "backtick";
          } else {
            this.flushQuotedIdentifier();
            this.mode = "normal";
            reprocess = true;
          }
          break;
        case "bracket":
          if (character === "]") {
            this.flushQuotedIdentifier();
            this.mode = "normal";
          } else {
            this.appendQuotedIdentifier(character);
          }
          break;
      }
    }
  }

  finish(): BackupSnapshotInventory {
    this.writeText(this.decoder.decode());
    switch (this.mode) {
      case "normal":
        this.flushWord();
        break;
      case "dash":
        this.interpreter.token("punctuation", "-");
        break;
      case "slash":
        this.interpreter.token("punctuation", "/");
        break;
      case "line_comment":
        break;
      case "single_quote_end":
        this.interpreter.token("string");
        break;
      case "double_quote_end":
      case "backtick_end":
        this.flushQuotedIdentifier();
        break;
      default:
        throw new Error("snapshot_inventory_invalid_sql_stream");
    }
    return this.interpreter.finish();
  }
}

export interface SnapshotInventoryScanner {
  write(chunk: Uint8Array): void;
  finish(): BackupSnapshotInventory;
}

export function createSnapshotInventoryScanner(): SnapshotInventoryScanner {
  return new StreamingSqlTokenizer();
}

export function snapshotInventoryFromSql(sql: string): BackupSnapshotInventory {
  const tokenizer = createSnapshotInventoryScanner();
  tokenizer.write(new TextEncoder().encode(sql));
  return tokenizer.finish();
}

export interface StreamingSnapshotInventory {
  readable: ReadableStream<Uint8Array>;
  result(): { digestHex: string; sizeBytes: number; snapshotInventory: BackupSnapshotInventory };
}

export function streamWithSnapshotInventory(source: ReadableStream<Uint8Array>): StreamingSnapshotInventory {
  const hash = createHash("sha256");
  const tokenizer = createSnapshotInventoryScanner();
  let sizeBytes = 0;
  let digestHex: string | undefined;
  let snapshotInventory: BackupSnapshotInventory | undefined;
  const readable = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!Number.isSafeInteger(sizeBytes + chunk.byteLength)) {
        throw new Error("d1_export_size_overflow");
      }
      hash.update(chunk);
      tokenizer.write(chunk);
      sizeBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      digestHex = hash.digest("hex");
      snapshotInventory = tokenizer.finish();
    },
  }));
  return {
    readable,
    result() {
      if (digestHex === undefined) {
        throw new Error("d1_export_stream_not_consumed");
      }
      if (snapshotInventory === undefined) {
        throw new Error("snapshot_inventory_not_computed");
      }
      return { digestHex, sizeBytes, snapshotInventory };
    },
  };
}
