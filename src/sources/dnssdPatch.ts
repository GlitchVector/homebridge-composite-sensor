import { createRequire } from "module";

/**
 * Patch `dnssd`'s BufferWrapper.readFQDN to guard against DNS compression
 * pointer loops.
 *
 * Why: `hap-controller`'s IPDiscovery uses `dnssd` for mDNS. dnssd@0.4.x
 * parses every mDNS packet the network emits; its readFQDN follows 0xC0
 * compression pointers without tracking visited offsets, so a packet whose
 * pointers form a cycle pegs a CPU core (observed 2026-04-24: 100% of one
 * core, stuck parsing an NSEC record). Packet's constructor wraps parseBuffer
 * in try/catch and marks isValid=false on throw, so it is safe to abort
 * readFQDN by throwing.
 *
 * This patch records each position reached via a pointer and throws if the
 * same position is revisited, or if the iteration count exceeds a sane cap.
 * Applied at plugin load so any IPDiscovery created later picks it up.
 */
type BufferWrapperLike = {
  remaining(): number;
  readUInt8(): number;
  readString(n: number): string;
  seek(p: number): void;
  position: number;
};

let patched = false;

export function patchDnssdReadFQDN(log?: { info: (s: string) => void; debug: (s: string) => void }): void {
  if (patched) {
    return;
  }
  try {
    const req = createRequire(import.meta.url);
    const BW = req("dnssd/lib/BufferWrapper");
    const proto = BW.prototype;
    if (typeof proto.readFQDN !== "function") {
      return;
    }
    proto.readFQDN = function patchedReadFQDN(this: BufferWrapperLike): string {
      const labels: string[] = [];
      const visited = new Set<number>();
      let len: number;
      let farthest: number | undefined;
      let iterations = 0;
      const MAX_ITERATIONS = 256;
      while (this.remaining() >= 0 && (len = this.readUInt8())) {
        if (++iterations > MAX_ITERATIONS) {
          throw new Error("dnssd readFQDN: iteration cap reached (malformed FQDN?)");
        }
        if (len < 192) {
          labels.push(this.readString(len));
        } else {
          const position = (len << 8) + this.readUInt8() - 0xc000;
          if (visited.has(position)) {
            throw new Error("dnssd readFQDN: compression pointer loop");
          }
          visited.add(position);
          if (farthest === undefined) {
            farthest = this.position;
          }
          this.seek(position);
        }
      }
      if (farthest !== undefined) {
        this.seek(farthest);
      }
      return labels.join(".") + ".";
    };
    patched = true;
    log?.info("patched dnssd BufferWrapper.readFQDN (pointer-loop guard)");
  } catch (err) {
    log?.debug(`dnssd readFQDN patch skipped: ${(err as Error).message}`);
  }
}
