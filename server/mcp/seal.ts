/**
 * What the MCP server hands out (client IDs, codes, tokens, the state it sends to GitHub) is sealed: its data,
 * encrypted and signed with a key only the server has (AES-GCM), so nothing is ever stored. The key comes from
 * the App's client secret through HKDF, so no other secret needs setting.
 */

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function keyOf(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('lemma-mcp'), info: encoder.encode('seal-v1') },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    keys.set(secret, key);
  }
  return key;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const base = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base + '='.repeat((4 - (base.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** 32 random bytes, for PKCE verifiers and the consent page's cookie. */
export const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** PKCE's S256 challenge of a verifier (RFC 7636). */
export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

/** What a sealed text is for; one kind never passes for another. */
export type SealKind = 'client' | 'consent' | 'state' | 'code' | 'access' | 'refresh';

/** `data` sealed as a `kind`, good until `expires` (epoch milliseconds). */
export async function seal(secret: string, kind: SealKind, data: object, expires: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify({ k: kind, x: expires, d: data }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(secret), plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return base64url(out);
}

/** What `seal` sealed as `kind`; null when it was changed, is of another kind, or has run out. */
export async function unseal<T>(secret: string, kind: SealKind, text: string): Promise<T | null> {
  try {
    const bytes = fromBase64url(text);
    if (bytes.length < 29) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await keyOf(secret), bytes.slice(12));
    const box = JSON.parse(new TextDecoder().decode(plain)) as { k?: unknown; x?: unknown; d?: T };
    return box.k === kind && typeof box.x === 'number' && box.x > Date.now() && box.d !== undefined ? box.d : null;
  } catch {
    return null;
  }
}
