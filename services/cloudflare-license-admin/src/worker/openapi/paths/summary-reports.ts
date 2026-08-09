import type { LabeledPathFragment } from "../assemble.js";
import {
  ADMIN_AUTH_ERRORS,
  ADMIN_MUTATION_AUTH_ERRORS,
  ADMIN_SECURITY,
  csvExportResponse,
  deviceKeyIdParam,
  errorResponse,
  featureKeyParam,
  formatCsvParam,
  idempotencyKeyHeader,
  idParam,
  limitCursorParams,
  okResponse,
  SYNC_SECURITY,
} from "../components.js";

export const summaryReportPaths: LabeledPathFragment = {
  label: "summary-reports",
  entries: [
    ["/api/admin/summary", {
    get: {
      tags: ["admin:reports"],
      summary: "Entitlement counts by status",
      operationId: "getAdminSummary",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse("Entitlement counts.", "#/components/schemas/SummaryData", "summary"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/report", {
    get: {
      tags: ["admin:reports"],
      summary: "Comprehensive system report with all metrics",
      operationId: "getAdminReport",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse("Full system metrics snapshot.", "#/components/schemas/ReportData", "report"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/report/timeseries", {
    get: {
      tags: ["admin:reports"],
      summary: "Bucketed usage + fulfillment time-series over a [from,to] window (reader+admin)",
      operationId: "getReportTimeseries",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "from", in: "query", required: false, description: "Window start (epoch seconds). Defaults to `to` minus 7 days.", schema: { type: "integer", minimum: 0 } },
        { name: "to", in: "query", required: false, description: "Window end (epoch seconds, exclusive upper edge). Defaults to now.", schema: { type: "integer", minimum: 0 } },
        { name: "buckets", in: "query", required: false, description: "Number of equal buckets to split the window into (default 24, clamped to 1..200).", schema: { type: "integer", default: 24, minimum: 1, maximum: 200 } },
      ],
      responses: {
        "200": okResponse("Per-bucket usage (checkouts/releases/denials/denial_rate) + fulfillment_events.", "#/components/schemas/TimeseriesData", "report_timeseries"),
        "400": errorResponse("Invalid window (from >= to).", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/report/expiring", {
    get: {
      tags: ["admin:reports"],
      summary: "Active entitlements expiring within N days, soonest first (reader+admin)",
      operationId: "getReportExpiring",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "within_days", in: "query", required: false, description: "Look-ahead horizon in days (default 30, clamped to 1..365).", schema: { type: "integer", default: 30, minimum: 1, maximum: 365 } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("Expiring-soon entitlement page (valid_until ASC) with days_left.", "#/components/schemas/ExpiringData", "report_expiring"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/audit/verify", {
    get: {
      tags: ["admin:reports"],
      summary: "Verify the tamper-evident audit hash chain over entitlement_events (reader+admin)",
      operationId: "verifyAuditChain",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse(
          "The chain-verification result; data.audit_chain.ok is false with brokenAt/reason when tampering is detected.",
          "#/components/schemas/AuditChainData",
          "audit_chain_ok",
        ),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
  ],
};

export const settingsPaths: LabeledPathFragment = {
  label: "summary-reports-settings",
  entries: [
    ["/api/admin/settings", {
    get: {
      tags: ["admin:reports"],
      summary: "Get worker configuration and auth settings",
      operationId: "getSettings",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse("Worker configuration.", "#/components/schemas/SettingsData", "settings"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
  ],
};
