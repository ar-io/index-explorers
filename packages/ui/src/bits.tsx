export function Badge({ text, kind }: { text: string; kind?: string }) {
  return <span class={`badge ${kind ?? ''}`}>{text}</span>;
}

/** A hue from an address, so owners tell apart at a glance. */
export function ownerHue(addr: string): number {
  let h = 0;
  for (const c of addr) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function OwnerDot({ addr }: { addr: string }) {
  return <i class="dot" style={{ background: `hsl(${ownerHue(addr)} 55% 55%)` }} />;
}
