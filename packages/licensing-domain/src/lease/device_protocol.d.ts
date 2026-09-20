export const DEVICE_LEASE_FIELDS: readonly string[];
export const DEVICE_COMPARISON_FIELDS: readonly string[];
export interface DeviceEnrollmentComparisonInput {attempt_handle:string;client_id:string;project:string;key_id:string;redirect_uri:string;state:string;code_challenge:string}
export function deviceEnrollmentComparisonInput(input:DeviceEnrollmentComparisonInput): Uint8Array<ArrayBuffer>;
export function formatDeviceEnrollmentComparison(digest:Uint8Array): string;
export const DEVICE_OPERATION_FIELDS: Readonly<Record<"exchange" | "renew", readonly string[]>>;
export function encodeBase64url(bytes: Uint8Array): string;
export function decodeBase64url(value: string, maxBytes?: number): Uint8Array<ArrayBuffer>;
export function encodeDeviceLeasePayload(claims: Record<string,string|number>): Uint8Array<ArrayBuffer>;
export function decodeDeviceLeasePayload(bytes: Uint8Array): Record<string,string|number>;
export function deviceLeaseSigningInput(payload: Uint8Array): Uint8Array<ArrayBuffer>;
export function encodeDeviceLeaseEnvelope(payload: Uint8Array, signature: Uint8Array): string;
export function decodeDeviceLeaseEnvelope(token: string): {payload:Uint8Array<ArrayBuffer>;signature:Uint8Array<ArrayBuffer>;claims:Record<string,string|number>};
export function deviceOperationBody(purpose: string, body: Record<string,string|number>): Uint8Array<ArrayBuffer>;
export function deviceOperationDigestInput(purpose: string, keyId: string, body: Record<string,string|number>): Uint8Array<ArrayBuffer>;
export function deviceProofSigningInput(input: Record<string,string|number>): Uint8Array<ArrayBuffer>;
export function decodeEnrollmentPageCursor(value: unknown): ["ep1", string, string, string, string];
