import { isIP } from "node:net";

let publicIp = "";
let lastLookupAt = 0;
let lookupInProgress = null;

export function getPublicIp() {
  return publicIp;
}

export function refreshPublicIp() {
  if (lookupInProgress) return lookupInProgress;
  if (Date.now() - lastLookupAt < 10 * 60 * 1000) return Promise.resolve(publicIp);

  lookupInProgress = (async () => {
    try {
      const response = await fetch("https://api.ipify.org?format=json", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`Public IP lookup failed (${response.status}).`);
      const result = await response.json();
      if (!isIP(result.ip)) throw new Error("A valid public IP address was not returned.");
      publicIp = result.ip;
    } catch (error) {
      console.warn(`공인 IP를 확인하지 못했습니다: ${error.message}`);
    } finally {
      lastLookupAt = Date.now();
      lookupInProgress = null;
    }
    return publicIp;
  })();

  return lookupInProgress;
}
