import "../ui/public/input-mode.js";
import { installTVInput } from "../ui/lib/tv/runtime";
installTVInput({
  kiosk: true,
  bridge: (command, data) => window.__cyberdeckInputBridge!(command, data),
});
