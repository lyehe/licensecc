export const ONLINE_REQUEST_PROOF_PURPOSE: "licensecc-online-request";
export const LEASE_REQUEST_PROOF_PURPOSE: "licensecc-lease-request";
export const SEAT_REQUEST_PROOF_PURPOSE: "licensecc-seat-request";
export const REQUEST_PROOF_VERSION: 1;
export const REQUEST_PROOF_ALGORITHM: "ecdsa-p256-sha256";

export type RequestProofPurposeV1 =
  | typeof ONLINE_REQUEST_PROOF_PURPOSE
  | typeof LEASE_REQUEST_PROOF_PURPOSE
  | typeof SEAT_REQUEST_PROOF_PURPOSE;

export interface RequestProofPayloadFieldsV1 {
  purpose: RequestProofPurposeV1;
  version: 1;
  algorithm: "ecdsa-p256-sha256";
  project: string;
  feature: string;
  licenseFingerprint: string;
  deviceHash: string;
  nonce: string;
  requestTimestamp: number;
  clientHardening: number;
  deviceKeyId: string;
}

export interface ParsedP256Spki {
  bytes: Uint8Array;
  publicX: string;
  publicY: string;
}

export function encodeCanonicalBase64(bytes: Uint8Array): string;
export function decodeCanonicalBase64(value: string, expectedLength?: number): Uint8Array;
export function p256SpkiDerFromCoordinates(publicX: string, publicY: string): Uint8Array;
export function parseP256SpkiDer(value: Uint8Array): ParsedP256Spki;
export function deriveDeviceKeyId(spkiDer: Uint8Array): Promise<string>;
export function canonicalRequestProofPayload(fields: RequestProofPayloadFieldsV1): string;
export function verifyRequestProofSignature(
  payload: string,
  publicKeySpkiDerBase64: string,
  signatureP1363Base64: string,
  expectedDeviceKeyId?: string,
): Promise<boolean>;
