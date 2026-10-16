(() => {
  let current = null, textTarget = null;
  const style = document.createElement('style');
  style.textContent = '.casework-selected {outline:4px solid #b8ef80!important;outline-offset:4px!important;box-shadow:0 0 0 7px #0008!important}';
  document.head.append(style);
  const entries = () => [...document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[tabindex="0"],video,iframe')].filter(el => {
    const r=el.getBoundingClientRect(), s=getComputedStyle(el);
    return !el.disabled && r.width>5 && r.height>5 && s.visibility!=='hidden' && s.display!=='none';
  });
  const select = el => {
    current?.classList.remove('casework-selected');current=el;
    if(el){el.classList.add('casework-selected');el.scrollIntoView({block:'nearest',inline:'nearest'});el.focus({preventScroll:true});}
  };
  window.caseworkRemote = {
    text(value) {
      if(!textTarget?.isConnected)return;
      const setter=Object.getOwnPropertyDescriptor(textTarget instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value')?.set;
      if(setter)setter.call(textTarget,value);else textTarget.value=value;
      textTarget.dispatchEvent(new Event('input',{bubbles:true}));textTarget.dispatchEvent(new Event('change',{bubbles:true}));
      textTarget.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
      textTarget.form?.requestSubmit();textTarget=null;
    },
    input(key) {
      if(current?.tagName==='IFRAME') {
        if(key==='back'){select(entries().find(el=>el!==current));return;}
        current.contentWindow?.postMessage({caseworkNativeInput:key},'*');return;
      }
      const all=entries();if(!current?.isConnected || !all.includes(current))select(all.find(el=>el.getBoundingClientRect().top>=0) || all[0]);
      if(key==='focus')return;
      if(key==='back'){history.back();return;}
      if(key==='pause') {
        const video=document.querySelector('video');if(video){video.paused?video.play().catch(()=>{}):video.pause();return;}
      }
      if(!current)return;
      if(key==='search'){select(all.find(el=>el.matches('input[type="search"],input[placeholder*="earch"]'))||current);key='select';}
      if(key==='select') {
        if(current.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]),textarea')) {
          textTarget=current;window.webkit.messageHandlers.caseworkInput.postMessage({type:'edit',value:current.value||''});
        } else if(current.tagName==='SELECT') {
          current.selectedIndex=(current.selectedIndex+1)%current.options.length;current.dispatchEvent(new Event('change',{bubbles:true}));
        } else if(current.tagName==='VIDEO'){current.paused?current.play().catch(()=>{}):current.pause();}
        else current.click();
        return;
      }
      if(current.matches('input[type="range"]') && (key==='left'||key==='right')) {
        key==='right'?current.stepUp():current.stepDown();current.dispatchEvent(new Event('input',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));return;
      }
      const r=current.getBoundingClientRect(), x=r.left+r.width/2,y=r.top+r.height/2;
      const horizontal=key==='left'||key==='right', positive=key==='right'||key==='down';
      if(!['left','right','up','down','next','previous'].includes(key))return;
      if(key==='next'||key==='previous'){window.scrollBy({top:innerHeight*(key==='next'?.7:-.7),behavior:'smooth'});return;}
      let next=null,best=Infinity;
      for(const el of all){if(el===current)continue;const q=el.getBoundingClientRect(),dx=q.left+q.width/2-x,dy=q.top+q.height/2-y;
        const main=horizontal?dx:dy,cross=horizontal?dy:dx;if((positive?main:-main)<5)continue;
        const score=Math.abs(main)+Math.abs(cross)*2.5;if(score<best){best=score;next=el;}}
      if(next)select(next);
    }
  };
  for(const delay of [100,500,1500])setTimeout(()=>{if(!current?.isConnected)window.caseworkRemote.input('focus');},delay);
  window.addEventListener('message',e=>{if(e.source===parent && typeof e.data?.caseworkNativeInput==='string')window.caseworkRemote.input(e.data.caseworkNativeInput);});
})();
