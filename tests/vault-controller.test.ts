import {test,expect} from "bun:test";
import {PlayerController} from "../ui/lib/vault-controller";
import {canUseNativeN64} from "../ui/lib/vault-native";
const pad=(buttons:number[]=[],y=0,index=0)=>({index,connected:true,buttons:Array.from({length:17},(_,i)=>({pressed:buttons.includes(i)})),axes:[0,y]});
test("Home and Back+Start open only once while held",()=>{
 for(const keys of [[16],[8,9]]){
 const c=new PlayerController(); expect(c.poll([pad(keys)],false,0)).toBe('menu');
 expect(c.poll([pad(keys)],true,16)).toBeUndefined();
 expect(c.poll([pad(keys)],true,900)).toBeUndefined();
 c.poll([pad()],true,1000);expect(c.poll([pad(keys)],true,1100)).toBe('menu');
 }
});
test("short Start reaches the game; holding it opens the menu without instantly closing",()=>{
 const c=new PlayerController();expect(c.poll([pad([9])],false,0)).toBeUndefined();
 expect(c.poll([pad([9])],false,699)).toBeUndefined();expect(c.poll([pad([9])],false,700)).toBe('menu');
 expect(c.poll([pad([9])],true,900)).toBeUndefined();c.poll([pad()],true,1000);
 expect(c.poll([pad([9])],true,1100)).toBe('resume');
});
test("menu supports all pads, stick repeat, A and B, and disconnects",()=>{
 const c=new PlayerController();expect(c.poll([null,pad([],0.8,1)],true,0)).toBe('down');
 expect(c.poll([pad([],0.8,1)],true,50)).toBeUndefined();expect(c.poll([pad([],0.8,1)],true,250)).toBe('down');
 c.poll([],true,300);expect(c.poll([pad([0])],true,400)).toBe('accept');
 expect(c.poll([pad([0])],true,450)).toBeUndefined();expect(c.poll([pad([1])],true,500)).toBe('resume');
});
test("native N64 is restricted to the physical loopback kiosk",()=>{
 expect(canUseNativeN64('N64','127.0.0.1',true)).toBe(true);
 expect(canUseNativeN64('N64','enuc.tail0bb35a.ts.net',true)).toBe(false);
 expect(canUseNativeN64('N64','127.0.0.1',false)).toBe(false);
 expect(canUseNativeN64('NES','127.0.0.1',true)).toBe(false);
});
