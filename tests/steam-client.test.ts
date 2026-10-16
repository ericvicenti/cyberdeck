import { expect, test } from "bun:test";
import { SteamClient } from "../src/daemon/api/steam-client";
function fixture(url = "ws://127.0.0.1:8080/devtools/page/fixture", response: any = { result: { value: [{ id: "400", name: "Portal", ready: true }, { id: "4;shutdown", name: "bad" }] } }) {
  const requests: any[] = [];
  class Socket {
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string) { queueMicrotask(() => this.onopen?.()); }
    send(data: string) { const command=JSON.parse(data); requests.push(command); queueMicrotask(() => this.onmessage?.({data:JSON.stringify({id:1,result:response})})); }
    close() {}
  }
  const client=new SteamClient((async (input:string) => {
    expect(input).toBe("http://127.0.0.1:8080/json/list");
    return Response.json([{title:"SharedJSContext",url:"https://steamloopback.host/index.html",webSocketDebuggerUrl:url}]);
  }) as typeof fetch,Socket as any);
  return {client,requests};
}
test("local Steam bridge reads owned game metadata and filters invalid IDs",async()=>{
 const {client,requests}=fixture();expect((await client.library()).map(g=>g.id)).toEqual(['400']);
 expect(requests[0].method).toBe('Runtime.evaluate');expect(requests[0].params.expression).toContain('a.BIsOwned()');expect(requests[0].params.expression).toContain('a.app_type === 1');
});
test("discovery cannot redirect the privileged bridge to another host/port/protocol",async()=>{
 for(const url of ['ws://evil.example:8080/devtools/x','ws://127.0.0.1:4777/x','wss://localhost:8080/x']) {
  const {client,requests}=fixture(url);await expect(client.library()).rejects.toThrow('Unexpected Steam bridge address');expect(requests).toHaveLength(0);
 }
});
test("Steam exceptions propagate instead of falsely acknowledging a launch",async()=>{
 const {client}=fixture(undefined,{exceptionDetails:{text:'Uncaught'}});await expect(client.play('400')).rejects.toThrow('Steam could not complete');
 await expect(client.play('400;process.exit()')).rejects.toThrow('Invalid Steam game ID');
});
