/* GAK landing — progressive enhancement, no dependencies. */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- header + progress ---------- */

  const header = $('#header');
  const progress = $('#progress');
  let ticking = false;

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY || document.documentElement.scrollTop;
      header.classList.toggle('is-scrolled', y > 8);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + '%';
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- mobile menu ---------- */

  const menuBtn = $('#menuBtn');
  const mobileNav = $('#mobileNav');
  const menuIcon = $('use', menuBtn);

  const setMenu = (open) => {
    mobileNav.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'إغلاق القائمة' : 'القائمة');
    menuIcon.setAttribute('href', open ? '#i-close' : '#i-menu');
    document.body.classList.toggle('is-locked', open);
  };

  menuBtn.addEventListener('click', () => setMenu(!mobileNav.classList.contains('is-open')));
  $$('a', mobileNav).forEach((a) => a.addEventListener('click', () => setMenu(false)));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1080) setMenu(false);
  });

  /* ---------- reveal on scroll ---------- */

  const revealEls = $$('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
    revealEls.forEach((el) => io.observe(el));
  }

  /* ---------- counters ---------- */

  const counters = $$('[data-count]');
  if (counters.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      counters.forEach((el) => { el.textContent = el.dataset.count; });
    } else {
      const run = (el) => {
        const target = Number(el.dataset.count) || 0;
        const start = performance.now();
        const dur = 900;
        const tick = (now) => {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          el.textContent = String(Math.round(target * eased));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
      const cio = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          run(entry.target);
          cio.unobserve(entry.target);
        });
      }, { threshold: 0.6 });
      counters.forEach((el) => {
        el.textContent = '0';
        cio.observe(el);
      });
    }
  }

  /* ---------- hero trace ---------- */

  const trace = $('#console');
  const replay = $('#replay');
  const reqLine = $('[data-seq="req"]', trace);
  const reqJson = $('[data-seq="json"]', trace);
  const result = $('[data-seq="result"]', trace);
  const step1 = $('[data-step="1"]', trace);
  const step2 = $('[data-step="2"]', trace);
  let timers = [];
  let traceRunning = false;

  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const paintFinal = () => {
    clearTimers();
    [reqLine, reqJson].forEach((el) => el.classList.add('is-in'));
    step1.classList.add('is-active', 'is-fail');
    step2.classList.add('is-active', 'is-ok');
    result.classList.add('is-in');
    traceRunning = false;
  };

  const resetTrace = () => {
    clearTimers();
    [reqLine, reqJson, result].forEach((el) => el.classList.remove('is-in'));
    [step1, step2].forEach((el) => el.classList.remove('is-active', 'is-fail', 'is-ok'));
  };

  const runTrace = () => {
    resetTrace();
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    at(220, () => reqLine.classList.add('is-in'));
    at(480, () => reqJson.classList.add('is-in'));
    at(900, () => step1.classList.add('is-active'));
    at(1620, () => step1.classList.add('is-fail'));
    at(1980, () => step2.classList.add('is-active'));
    at(2760, () => step2.classList.add('is-ok'));
    at(3000, () => result.classList.add('is-in'));
    at(6300, runTrace);
    traceRunning = true;
  };

  if (reduceMotion) {
    paintFinal();
    replay.hidden = true;
  } else if ('IntersectionObserver' in window) {
    const tio = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (!traceRunning) runTrace();
        } else {
          clearTimers();
          traceRunning = false;
        }
      });
    }, { threshold: 0.25 });
    tio.observe(trace);
    replay.addEventListener('click', runTrace);
  } else {
    paintFinal();
  }

  /* ---------- tabs (generic, keyboard aware) ---------- */

  const bindTabs = (buttons, activate) => {
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => activate(btn));
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = buttons[(i + dir + buttons.length) % buttons.length];
        next.focus();
        activate(next);
      });
    });
  };

  /* ---------- code tabs ---------- */

  const codeTabs = $$('.tab');
  const codePanels = $$('.code-panel');
  const codeFile = $('#codeFile');
  const copyCode = $('#copyCode');
  const fileNames = { 'panel-curl': 'terminal', 'panel-openai': 'python', 'panel-anthropic': 'python', 'panel-claude': 'bash' };

  const activateCode = (btn) => {
    const id = btn.getAttribute('aria-controls');
    codeTabs.forEach((t) => t.setAttribute('aria-selected', String(t === btn)));
    codePanels.forEach((p) => p.classList.toggle('is-active', p.id === id));
    codeFile.textContent = fileNames[id] || 'terminal';
    copyCode.dataset.copy = id;
  };
  bindTabs(codeTabs, activateCode);

  /* ---------- dashboard tabs ---------- */

  const dashTabs = $$('.dash-tab');
  const shot = $('#dashShot');
  const dashLink = $('#dashLink');
  const caption = $('#dashCaption');
  shot.style.transition = 'opacity .22s ease';

  const activateDash = (btn) => {
    dashTabs.forEach((t) => t.setAttribute('aria-selected', String(t === btn)));
    caption.textContent = btn.dataset.caption || '';
    shot.style.opacity = '0';
    const next = new Image();
    next.onload = () => {
      shot.src = btn.dataset.shot;
      shot.alt = btn.dataset.alt || 'لوحة GAK';
      if (dashLink) dashLink.href = btn.dataset.shot;
      shot.style.opacity = '1';
    };
    next.onerror = () => { shot.style.opacity = '1'; };
    next.src = btn.dataset.shot;
  };
  bindTabs(dashTabs, activateDash);
  dashTabs.forEach((btn) => {
    btn.addEventListener('pointerenter', () => {
      const img = new Image();
      img.src = btn.dataset.shot;
    }, { once: true });
  });

  /* ---------- providers filter ---------- */

  const provGrid = $('#provGrid');
  const provItems = $$('.provider', provGrid);
  const provSearch = $('#provSearch');
  const provCount = $('#provCount');
  const provEmpty = $('#provEmpty');
  const filterBtns = $$('.filter');
  let activeTier = 'all';

  const applyProviders = () => {
    const q = (provSearch.value || '').trim().toLowerCase();
    let shown = 0;
    provItems.forEach((el) => {
      const tierOk = activeTier === 'all' || el.dataset.tier === activeTier;
      const nameOk = !q || (el.dataset.name || '').includes(q) || el.textContent.toLowerCase().includes(q);
      const visible = tierOk && nameOk;
      el.classList.toggle('is-off', !visible);
      if (visible) shown += 1;
    });
    provCount.textContent = shown + ' / ' + provItems.length;
    provEmpty.classList.toggle('is-on', shown === 0);
  };

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTier = btn.dataset.filter;
      filterBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      applyProviders();
    });
  });
  provSearch.addEventListener('input', applyProviders);
  provSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    provSearch.value = '';
    applyProviders();
  });

  /* ---------- clipboard ---------- */

  const toast = $('#toast');
  let toastTimer;
  const showToast = (msg) => {
    toast.textContent = msg;
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1800);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
    }
  };

  const flash = (btn) => {
    const label = $('span', btn);
    const old = label.textContent;
    btn.classList.add('is-done');
    label.textContent = 'تم النسخ';
    setTimeout(() => {
      btn.classList.remove('is-done');
      label.textContent = old;
    }, 1600);
  };

  copyCode.addEventListener('click', async () => {
    const panel = document.getElementById(copyCode.dataset.copy || 'panel-curl');
    const code = $('code', panel);
    await copyText(code.innerText.trim());
    flash(copyCode);
    showToast('تم نسخ المثال');
  });

  const copyInstall = $('#copyInstall');
  copyInstall.addEventListener('click', async () => {
    const cmds = $$('#installCmd .cmd').map((el) => el.textContent.trim()).join('\n');
    await copyText(cmds);
    flash(copyInstall);
    showToast('تم نسخ أوامر التشغيل');
  });

  /* ---------- misc ---------- */

  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  const faqItems = $$('.faq-item');
  faqItems.forEach((item) => {
    item.addEventListener('toggle', () => {
      if (!item.open) return;
      faqItems.forEach((other) => {
        if (other !== item) other.open = false;
      });
    });
  });
})();
