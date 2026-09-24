(() => {
  // The user selected the Panda palette; previous comparison choices no longer apply.
  const densityKey='novelsub-preview-density-v2';
  function apply(){
    document.body.dataset.theme='panda';
    let density='comfortable';
    try { density=localStorage.getItem(densityKey)||density; } catch {}
    document.body.dataset.density=density==='compact'?'compact':'comfortable';
    const compact=document.body.dataset.density==='compact';
    document.querySelector('#density-label').textContent=compact?'紧凑':'舒适';
    document.querySelector('#density-toggle').setAttribute('aria-label',compact?'切换为舒适行距':'切换为紧凑行距');
  }
  document.addEventListener('click',event=>{
    if(event.target.closest('#density-toggle')){
      try {localStorage.setItem(densityKey,document.body.dataset.density==='compact'?'comfortable':'compact');} catch {}
      apply();
    }
  });
  apply();
})();
