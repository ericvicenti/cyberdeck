/** Fixed-purpose bridge to the user's local Steam client. Never accepts script or URLs from HTTP callers. */
export type ClientGame = { id: string; name: string; ready: boolean; status: number; progress: number; compatible: boolean };
export const LIBRARY_SCRIPT = `(() => {
 if (typeof appStore === 'undefined' || !appStore.allApps) throw Error('Steam is still starting or needs sign-in');
 return appStore.allApps.filter(a => a.app_type === 1 && a.BIsOwned()).map(a => {
   const p = a.GetPerClientData('local') || {};
   return {id:String(a.appid),name:a.display_name,ready:!!p.installed && (p.display_status===11 || p.display_status===4),status:p.display_status||0,progress:p.status_percentage||0,compatible:p.is_available_on_current_platform===true};
 });
})()`;
export class SteamClient {
  constructor(private fetcher: typeof fetch = fetch, private Socket: typeof WebSocket = WebSocket) {}
  private async evaluate<T>(expression: string): Promise<T> {
    const response = await this.fetcher("http://127.0.0.1:8080/json/list", { signal: AbortSignal.timeout(2500) });
    const targets = await response.json();
    const target = Array.isArray(targets) && targets.find(t => t.title === "SharedJSContext" && String(t.url).startsWith("https://steamloopback.host/"));
    if (!target) throw new Error("Steam is still starting or needs sign-in");
    const ws = new URL(target.webSocketDebuggerUrl);
    if (ws.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(ws.hostname) || ws.port !== "8080") throw new Error("Unexpected Steam bridge address");
    // Pin even the discovered WebSocket to loopback. No arbitrary remote page evaluation.
    ws.hostname = "127.0.0.1";
    return new Promise<T>((resolve, reject) => {
      const socket = new this.Socket(ws.toString());
      const timer = setTimeout(() => finish(new Error("Steam did not respond")), 8000);
      let done = false;
      const finish = (error?: Error, value?: T) => {
        if (done) return; done = true; clearTimeout(timer); socket.close();
        error ? reject(error) : resolve(value!);
      };
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      socket.onmessage = event => {
        try {
          if (String(event.data).length > 4 * 1024 * 1024) return finish(new Error("Steam response too large"));
          const message = JSON.parse(String(event.data));
          if (message.id !== 1) return;
          if (message.error || message.result?.exceptionDetails) return finish(new Error("Steam could not complete this request"));
          finish(undefined, message.result?.result?.value);
        } catch { finish(new Error("Invalid Steam response")); }
      };
      socket.onerror = () => finish(new Error("Steam connection failed"));
      socket.onclose = () => finish(new Error("Steam connection closed"));
    });
  }
  async library(): Promise<ClientGame[]> {
    const games = await this.evaluate<ClientGame[]>(LIBRARY_SCRIPT);
    if (!Array.isArray(games)) throw new Error("Steam library unavailable");
    return games.filter(g => /^[1-9]\d{0,9}$/.test(g.id) && typeof g.name === "string").slice(0, 10000);
  }
  private id(id: string) { if (!/^[1-9]\d{0,9}$/.test(id)) throw new Error("Invalid Steam game ID"); return id; }
  async play(id: string) {
    return this.evaluate(`(() => { const a=appStore.GetAppOverviewByAppID(${this.id(id)}); if(!a?.BIsOwned()) throw Error('Not owned'); SteamClient.Apps.RunGame(a.GetGameID(), '', -1, 0); return true; })()`);
  }
  async resume(id: string) { return this.evaluate(`(() => { SteamClient.Apps.RaiseWindowForGame('${this.id(id)}'); return true; })()`); }
  async stop(id: string) { return this.evaluate(`(() => { SteamClient.Apps.TerminateApp('${this.id(id)}', false); return true; })()`); }
  async install(id: string) {
    return this.evaluate(`(async () => { const a=appStore.GetAppOverviewByAppID(${this.id(id)}); if(!a?.BIsOwned()) throw Error('Not owned'); if(a.GetPerClientData('local')?.installed) { SteamClient.Downloads.ResumeAppUpdate(${id}, '0'); return true; } await SteamClient.Installs.OpenInstallWizard([${id}]); return true; })()`);
  }
  async actions() {
    return this.evaluate<{ nGameActionID: number; gameid: string; strActionName: string; strTaskName: string; strTaskDetails: string; bWaitingForUI: boolean }[]>("SteamClient.Apps.GetActiveGameActions()");
  }
  async respond(action: number, choice: "IgnoreCloud" | "KeepLocal" | "KeepRemote" | "IgnorePendingCloudSessions") {
    if (!Number.isSafeInteger(action) || action < 1) throw new Error("Invalid game action");
    if (!["IgnoreCloud", "KeepLocal", "KeepRemote", "IgnorePendingCloudSessions"].includes(choice)) throw new Error("Invalid game choice");
    return this.evaluate(`(() => { SteamClient.Apps.ContinueGameAction(${action}, ${JSON.stringify(choice)}); return true; })()`);
  }
  async cancelLaunch(id: string) { return this.evaluate(`(() => { SteamClient.Apps.CancelLaunch('${this.id(id)}'); return true; })()`); }
  async cancelInstall(id: string) {
    return this.evaluate(`(async()=>{ const s=await SteamClient.Installs.GetInstallManagerInfo(); if(s.currentAppID===${this.id(id)}) await SteamClient.Installs.CancelInstall(); SteamClient.Downloads.PauseAppUpdate(${id}, '0'); return true; })()`);
  }
  async installation() {
    return this.evaluate<{ eInstallState: number; currentAppID: number; nDiskSpaceRequired: number; nDiskSpaceAvailable: number; eAppError: number; errorDetail: string }>("SteamClient.Installs.GetInstallManagerInfo()");
  }
  async continueInstall() {
    // Only advance the disk/shortcut configuration step. Never accept a license agreement implicitly.
    return this.evaluate(`(async()=>{ const s=await SteamClient.Installs.GetInstallManagerInfo(); if(s.eInstallState!==7) return false; if(s.nDiskSpaceRequired>s.nDiskSpaceAvailable) throw Error('Not enough disk space'); await SteamClient.Installs.SetCreateShortcuts(false,false); await SteamClient.Installs.ContinueInstall(); return true; })()`);
  }
  async background() {
    return this.evaluate("(() => { SteamClient.UI.ExitBigPictureMode(); return true; })()");
  }
}
