/** The kiosk uses loopback for Gamepad API, but an iPad needs the fleet address. */
export async function pairingOrigin(): Promise<string> {
  return window.__cyberdeckInputBridge
    ? window.__cyberdeckInputBridge("pairingOrigin")
    : location.origin;
}
