/**
 * Kept in its own module so client components can import HTML helpers without
 * dragging node:crypto (via the unsubscribe signer) into the browser bundle.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
