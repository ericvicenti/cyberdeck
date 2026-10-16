import { beforeAll, afterAll, test, expect } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
let browser: Browser;
let page: Page;
const source = readFileSync(new URL('../ui/public/input-mode.js', import.meta.url), 'utf8');
beforeAll(async () => { browser = await chromium.launch({headless:true}); });
afterAll(async () => { await browser?.close(); });
async function fixture() {
  await page?.close(); page = await browser.newPage();
  await page.setContent('<input id="text" value=""><button id="ordinary">Ordinary</button><p data-controller-only>Gamepad hint</p>');
  await page.addScriptTag({content:source});
}
const mode = () => page.evaluate(() => document.documentElement.dataset.inputMode);
test('only active controller input shows hints; keyboard and pointer immediately take over', async () => {
  await fixture();
  await page.evaluate(() => {
    (window as any).pads = [{index:0, buttons:[{pressed:false}],axes:[0.1,0]}];
    Object.defineProperty(navigator,'getGamepads',{value:()=>(window as any).pads});
    (window as any).caseworkInput.sample();
  });
  expect(await mode()).toBe('pointer');
  await page.evaluate(() => { (window as any).pads[0].buttons[0].pressed=true; (window as any).caseworkInput.sample(); });
  expect(await mode()).toBe('controller');expect(await page.locator('[data-controller-only]').isVisible()).toBe(true);
  await page.locator('#text').focus();await page.keyboard.type('hello world');
  expect(await mode()).toBe('keyboard');expect(await page.locator('#text').inputValue()).toBe('hello world');
  expect(await page.locator('[data-controller-only]').isVisible()).toBe(false);
  await page.evaluate(() => (window as any).caseworkInput.sample());expect(await mode()).toBe('keyboard');
  await page.evaluate(() => { (window as any).pads[0].buttons[0].pressed=false; (window as any).caseworkInput.sample(); (window as any).pads[0].buttons[0].pressed=true; (window as any).caseworkInput.sample(); });
  expect(await mode()).toBe('controller');await page.locator('#ordinary').click();expect(await mode()).toBe('pointer');
});
async function keyboardOverlay() {
  await page.evaluate(() => {
    (window as any).caseworkInput.setMode('controller');
    const input=document.querySelector('input')!;
    const overlay=document.createElement('div');overlay.className='cd-tv-overlay';
    overlay.innerHTML='<div class="cd-tv-keys"><button>A</button></div><button id="done">Done</button>';
    document.body.append(overlay);
    overlay.querySelector('#done')!.addEventListener('click',()=>{input.value='typed on pad';overlay.remove();input.focus();input.setSelectionRange(input.value.length,input.value.length)});
    (overlay.querySelector('button') as HTMLElement).focus();
    // Emulate the legacy TV runtime: it would consume native spaces and arrows if not intercepted.
    window.addEventListener('keydown',e=>{if([' ','ArrowLeft'].includes(e.key))e.preventDefault()},true);
  });
}
test('first physical key closes virtual keyboard, keeps entered text, and continues native editing', async () => {
  await fixture();await keyboardOverlay();
  await page.keyboard.type(' now');
  expect(await page.locator('.cd-tv-overlay').count()).toBe(0);
  expect(await page.locator('#text').inputValue()).toBe('typed on pad now');
  await page.keyboard.press('ArrowLeft');await page.keyboard.type('X');
  expect(await page.locator('#text').inputValue()).toBe('typed on pad noXw');
  expect(await mode()).toBe('keyboard');
});
test('pointer takeover closes the virtual keyboard without losing its pending value', async () => {
  await fixture();await keyboardOverlay();const box=await page.locator('.cd-tv-keys button').boundingBox();await page.mouse.click(box!.x+box!.width/2,box!.y+box!.height/2);
  expect(await page.locator('.cd-tv-overlay').count()).toBe(0);
  expect(await page.locator('#text').inputValue()).toBe('typed on pad');expect(await mode()).toBe('pointer');
});
test('document-start kiosk bootstrap keeps physical text editing native', async () => {
  await page?.close();page=await browser.newPage();
  const errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript({content:source});
  await page.goto('data:text/html,<input id="text"><p data-controller-only>Gamepad hint</p>');
  await page.evaluate(()=>window.addEventListener('keydown',e=>{if([' ','ArrowLeft'].includes(e.key))e.preventDefault()},true));
  await page.locator('#text').fill('ready');await page.locator('#text').press('End');await page.keyboard.type(' now');
  expect(await page.locator('#text').inputValue()).toBe('ready now');expect(await mode()).toBe('keyboard');expect(errors).toEqual([]);
});
