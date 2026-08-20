/**
 * Rasterises the signature social icons into `public/signature/*.png`.
 *
 * Run with: npm run signature-icons
 *
 * Only needed when a mark or a brand colour changes — the PNGs are committed, so
 * a normal build and deploy never runs this. `sharp` comes in with Next rather
 * than as a dependency of ours for that reason; if it has gone missing, this
 * script is the only thing that breaks.
 *
 * Why PNGs and not the inline SVG the website uses: Gmail, Outlook and Yahoo
 * all strip `<svg>` out of a message body, and Gmail's image proxy refuses to
 * serve an `.svg` referenced from `<img>`. A hosted PNG is the only icon format
 * every mail client renders, so the paths below — copied verbatim from
 * orankly.com's footer so the marks match the site exactly — are baked into
 * bitmaps once, at build time, rather than shipped as markup.
 *
 * 44px is 2× the 22px display size, so the icons stay sharp on a retina screen.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { SOCIAL_PROFILES } from "../src/mail/signature";

/** Verbatim from the orankly.com footer, keyed to the profiles module. */
const ICON_PATHS: Record<string, { d: string; evenOdd?: boolean }> = {
  whatsapp: {
    d: "M12 2a10 10 0 0 0-8.6 15l-1.4 5 5.1-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20zm4.4-6c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.8 1-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.2a.4.4 0 0 0 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1c0 1.2.9 2.4 1 2.6s1.8 2.8 4.4 3.9 2.6.7 3.1.7a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3z",
  },
  linkedin: {
    d: "M4.98 3.5A2.5 2.5 0 1 1 5 8.5 2.5 2.5 0 0 1 4.98 3.5zM3 9h4v12H3zM9 9h3.8v1.75h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.3-.02-2.97-1.81-2.97-1.81 0-2.09 1.42-2.09 2.88V21H9z",
  },
  facebook: {
    d: "M14 9h3V6h-3c-2 0-3 1.5-3 3.5V11H8.5v3H11v8h3v-8h2.5l.5-3H14V9.5c0-.3.2-.5.5-.5z",
  },
  instagram: {
    d: "M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7zm5 3.2A4.8 4.8 0 1 1 7.2 12 4.8 4.8 0 0 1 12 7.2zm0 2A2.8 2.8 0 1 0 14.8 12 2.8 2.8 0 0 0 12 9.2zM17.4 5.25a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7z",
    evenOdd: true,
  },
};

const SIZE = 44;
const OUT_DIR = path.join(process.cwd(), "public", "signature");

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const profile of SOCIAL_PROFILES) {
    const icon = ICON_PATHS[profile.key];
    if (!icon) throw new Error(`No icon path for ${profile.key}.`);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><path fill="${profile.brand}"${
      icon.evenOdd ? ' fill-rule="evenodd"' : ""
    } d="${icon.d}"/></svg>`;

    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    const file = path.join(OUT_DIR, `${profile.key}.png`);
    await writeFile(file, png);
    console.log(`  ${profile.key}.png  ${png.length} bytes`);
  }
}

void main();
