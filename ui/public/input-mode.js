/* Shared last-used-input behavior for Cyberdeck, Games and embedded apps. */
(() => {
  if (window.caseworkInput) return;
  const root = document.documentElement;
  let mode = 'pointer', lastPointer = null;
  const pads = new Map();
  const editable = el => el?.matches?.('textarea,[contenteditable="true"],input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])');
  const style = document.createElement('style');
  style.textContent = `
    html[data-input-mode="pointer"] [data-tv-focused], html[data-input-mode="pointer"][data-cyberdeck-tv] :focus,
    html[data-input-mode="pointer"] .casework-selected {outline:none!important;box-shadow:none!important}
    html[data-input-mode="keyboard"][data-cyberdeck-tv] :focus {outline:2px solid currentColor!important;outline-offset:3px!important}
    html:not([data-input-mode="controller"]) [data-controller-only],
    html:not([data-input-mode="controller"]) [data-tv-gamepad-hint],
    html:not([data-input-mode="controller"]) .gamepad-hint,
    html:not([data-input-mode="controller"]) .controller-hint,
    html:not([data-input-mode="controller"]) section[aria-label="Retro games"] [role="status"] > span:nth-child(2) {display:none!important}
    html[data-input-mode="pointer"][data-cyberdeck-tv] [data-testid^="nav-"]:focus::after {display:none!important}
  `;
  if (document.head || root) (document.head || root).append(style);
  else document.addEventListener('DOMContentLoaded', () => { document.head.append(style); setMode(mode); }, {once:true});
  function setMode(next, propagate = true, source = null) {
    if (!['controller','keyboard','pointer'].includes(next)) return;
    const changed = next !== mode;
    mode = next; if (document.documentElement) document.documentElement.dataset.inputMode = next;
    if (changed) window.dispatchEvent(new CustomEvent('casework:input-mode', {detail:{mode:next}}));
    if (changed && propagate) {
      const message = {caseworkInputMode: next};
      if (window.parent !== window && window.parent !== source) window.parent.postMessage(message, '*');
      for (const frame of document.querySelectorAll('iframe')) if(frame.contentWindow !== source) frame.contentWindow?.postMessage(message,'*');
    }
  }
  function handoffKeyboard(event) {
    const overlay = document.querySelector('.cd-tv-overlay:has(.cd-tv-keys)');
    if (!overlay) return false;
    const cancel = event.key === 'Escape';
    const button = [...overlay.querySelectorAll('button')].find(b => b.textContent.trim() === (cancel ? 'Cancel' : 'Done'));
    if (!button) return false;
    button.click();
    const target = document.activeElement;
    if (!cancel && editable(target) && event.type === 'keydown') {
      const value = target.value ?? target.textContent ?? '';
      let start = target.selectionStart ?? value.length, end = target.selectionEnd ?? start;
      let replacement = null;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) replacement = event.key;
      else if (event.key === 'Backspace') { if (start === end) start = Math.max(0,start-1); replacement = ''; }
      else if (event.key === 'Delete') { if (start === end) end = Math.min(value.length,end+1); replacement = ''; }
      if (replacement !== null) {
        const next = value.slice(0,start)+replacement+value.slice(end);
        const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype,'value')?.set;
        if ('value' in target) setter ? setter.call(target,next) : target.value = next;
        else target.textContent = next;
        target.dispatchEvent(new Event('input',{bubbles:true}));
        target.setSelectionRange?.(start+replacement.length,start+replacement.length);
      } else if (event.key === 'Enter') target.form?.requestSubmit();
    }
    event.preventDefault(); event.stopImmediatePropagation();
    return true;
  }
  window.addEventListener('keydown', event => {
    if (event.isTrusted === false || event.isComposing) return;
    handoffKeyboard(event); setMode('keyboard');
    // Text fields always keep native typing, cursor movement and Space/Enter handling.
    // The TV runtime must not turn those keys into gamepad navigation or playback.
    if (editable(document.activeElement) && event.key !== 'Escape') event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointerdown', event => {
    if (event.isTrusted === false) return;
    handoffKeyboard(event); setMode('pointer');
  }, true);
  window.addEventListener('pointermove', event => {
    if (event.isTrusted === false) return;
    const p = [event.clientX,event.clientY];
    if (lastPointer && Math.abs(p[0]-lastPointer[0])+Math.abs(p[1]-lastPointer[1]) > 4) setMode('pointer');
    lastPointer = p;
  }, true);
  window.addEventListener('message', event => {
    const related = event.source === window.parent || [...document.querySelectorAll('iframe')].some(f=>f.contentWindow===event.source);
    if (related && event.data?.caseworkInputMode) setMode(event.data.caseworkInputMode, true, event.source);
  });
  function sample() {
    let devices; try { devices = navigator.getGamepads?.() || []; } catch { return; }
    for (const pad of devices) {
      if (!pad) continue;
      const values = [...pad.buttons.map(b=>b.pressed ? 1 : 0),...pad.axes.map(v=>Math.abs(v)>0.6 ? Math.sign(v) : 0)];
      const previous = pads.get(pad.index) || values.map(()=>0);
      if (values.some((v,i)=>v && v!==previous[i])) setMode('controller');
      pads.set(pad.index,values);
    }
  }
  window.caseworkInput = {setMode, get mode(){return mode}, handoffKeyboard, sample};
  setMode(mode);
  setInterval(sample,100);
})();
