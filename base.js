/* Login e conexão com o Supabase. Oferece à página a mesma interface de banco que ela já usa. */
(() => {
  'use strict';
  const cfg = window.PAUTA_CONFIG || {};
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  let sessao = null, abre;
  const logado = new Promise(r => (abre = r));
  const erroDb = e => {
    const m = String((e && (e.message || e.code)) || '');
    if (/row-level|permission|violates|JWT|42501/i.test(m + (e && e.code))) return { code: 'invalid_argument', message: m };
    return { code: 'unavailable', message: m };
  };
  const ok = async q => { const r = await q; if (r.error) throw erroDb(r.error); return r; };

  const colecoes = {};
  const docsDe = c => (colecoes[c] = colecoes[c] || { mapa: new Map(), ouvintes: new Set(), docOuv: new Map(), iniciada: false });
  const snapDoc = (id, dados) => ({ id, exists: dados !== undefined, data: () => dados, metadata: { fromCache: false, hasPendingWrites: false } });
  function avisa(c, id) {
    const x = docsDe(c);
    const docs = [...x.mapa.entries()].map(([i, d]) => snapDoc(i, d));
    x.ouvintes.forEach(f => f({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }));
    (id ? [[id, x.docOuv.get(id)]] : [...x.docOuv.entries()]).forEach(([i, s]) => s && s.forEach(f => f(snapDoc(i, x.mapa.get(i)))));
  }
  async function carrega(c) {
    const x = docsDe(c), novo = new Map();
    for (let de = 0; ; de += 1000) {
      const { data } = await ok(sb.from('docs').select('id,dados').eq('colecao', c).order('id').range(de, de + 999));
      data.forEach(l => novo.set(l.id, l.dados));
      if (data.length < 1000) break;
    }
    x.mapa = novo; avisa(c);
  }
  function inicia(c, erro) {
    const x = docsDe(c);
    if (x.iniciada) return;
    x.iniciada = true;
    logado.then(() => {
      carrega(c).catch(erro);
      sb.channel('docs-' + c)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'colecao=eq.' + c }, p => {
          if (p.eventType === 'DELETE') carrega(c).catch(() => {});
          else { x.mapa.set(p.new.id, p.new.dados); avisa(c, p.new.id); }
        })
        .subscribe(st => { if (st === 'SUBSCRIBED') carrega(c).catch(() => {}); });
      /* Rede de segurança caso o tempo real caia sem aviso. */
      setInterval(() => { if (!document.hidden) carrega(c).catch(() => {}); }, 60000);
      addEventListener('focus', () => carrega(c).catch(() => {}));
    });
  }
  function docRef(path) {
    const [c, id] = path.split('/');
    return {
      id, path,
      async get() {
        await logado;
        const { data } = await ok(sb.from('docs').select('dados').eq('colecao', c).eq('id', id).maybeSingle());
        return snapDoc(id, data ? data.dados : undefined);
      },
      async set(dados) {
        await logado;
        await ok(sb.from('docs').upsert({ colecao: c, id, dados }, { onConflict: 'colecao,id' }));
        docsDe(c).mapa.set(id, dados); avisa(c, id);
      },
      async update(dados) {
        await logado;
        await ok(sb.rpc('doc_merge', { p_colecao: c, p_id: id, p_dados: dados }));
        const x = docsDe(c); x.mapa.set(id, { ...(x.mapa.get(id) || {}), ...dados }); avisa(c, id);
      },
      async delete() {
        await logado;
        await ok(sb.from('docs').delete().eq('colecao', c).eq('id', id));
        docsDe(c).mapa.delete(id); avisa(c, id);
      },
      onSnapshot(prox, erro) {
        const x = docsDe(c);
        if (!x.docOuv.has(id)) x.docOuv.set(id, new Set());
        x.docOuv.get(id).add(prox);
        inicia(c, erro || (() => {}));
        return () => x.docOuv.get(id).delete(prox);
      },
    };
  }
  const db = {
    doc: docRef,
    collection: c => ({
      path: c,
      doc: id => docRef(c + '/' + (id || crypto.randomUUID())),
      onSnapshot(prox, erro) {
        const x = docsDe(c);
        x.ouvintes.add(prox);
        inicia(c, erro || (() => {}));
        return () => x.ouvintes.delete(prox);
      },
    }),
  };
  const user = {
    can: async () => true,
    me: async () => {
      await logado;
      const email = sessao.user.email || '';
      const { data } = await sb.from('membros').select('nome').eq('email', email).maybeSingle();
      return { id: sessao.user.id, name: (data && data.nome) || '' };
    },
  };
  const downloads = {
    save: async ({ filename, data }) => {
      const url = URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { status: 'saved' };
    },
  };
  window.claude = { use: async n => { await logado; return { db, user, downloads }[n] || null; } };

  function telaLogin(msg) {
    let t = document.getElementById('login');
    if (!t) {
      t = document.createElement('div');
      t.id = 'login'; t.className = 'overlay'; t.style.zIndex = 50; t.style.background = 'var(--side)';
      t.innerHTML = `<form class="sheet" style="width:min(380px,100%);margin-top:12vh"><h2>Pauta Jurídica</h2>
        <div class="fld"><label for="lg-e">E-mail</label><input id="lg-e" type="email" required autocomplete="username"></div>
        <div class="fld"><label for="lg-s">Senha</label><input id="lg-s" type="password" required autocomplete="current-password"></div>
        <small id="lg-m" style="color:var(--crit)"></small><button class="btn pri">Entrar</button></form>`;
      document.body.append(t);
      t.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); ev.stopPropagation();
        const b = t.querySelector('button'), m = t.querySelector('#lg-m');
        b.disabled = true; m.textContent = '';
        const r = await sb.auth.signInWithPassword({ email: t.querySelector('#lg-e').value.trim(), password: t.querySelector('#lg-s').value });
        b.disabled = false;
        if (r.error) { m.textContent = 'E-mail ou senha incorretos.'; return; }
        await entra(r.data.session);
      });
    }
    t.hidden = false;
    t.querySelector('#lg-m').textContent = msg || '';
  }
  function telaSenha() {
    const t = document.createElement('div');
    t.className = 'overlay'; t.style.zIndex = 50;
    t.innerHTML = `<form class="sheet" style="width:min(380px,100%);margin-top:12vh"><h2>Criar ou trocar senha</h2>
      <div class="fld"><label for="sn-1">Nova senha</label><input id="sn-1" type="password" required minlength="10" autocomplete="new-password"><small>Use pelo menos 10 caracteres.</small></div>
      <div class="fld"><label for="sn-2">Repita a senha</label><input id="sn-2" type="password" required minlength="10" autocomplete="new-password"></div>
      <small id="sn-m" style="color:var(--crit)"></small>
      <div class="btns"><button class="btn pri">Salvar senha</button><button type="button" class="btn" id="sn-x">Cancelar</button></div></form>`;
    document.body.append(t);
    t.querySelector('#sn-x').onclick = () => t.remove();
    t.querySelector('form').addEventListener('submit', async ev => {
      ev.preventDefault(); ev.stopPropagation();
      const a = t.querySelector('#sn-1').value, m = t.querySelector('#sn-m');
      if (a !== t.querySelector('#sn-2').value) { m.textContent = 'As senhas não são iguais.'; return; }
      const r = await sb.auth.updateUser({ password: a });
      if (r.error) { m.textContent = 'Não foi possível salvar. Tente uma senha mais forte.'; return; }
      t.remove();
      const av = document.getElementById('toast');
      if (av) { av.textContent = 'Senha salva.'; av.hidden = false; setTimeout(() => (av.hidden = true), 4000); }
    });
  }
  async function entra(s) {
    const r = await sb.from('membros').select('email').eq('email', s.user.email).maybeSingle();
    if (r.error && !/fetch|network/i.test(r.error.message || '')) { await sb.auth.signOut(); telaLogin('Não foi possível validar seu acesso.'); return; }
    if (!r.error && !r.data) { await sb.auth.signOut(); telaLogin('Este e-mail não tem acesso ao sistema.'); return; }
    sessao = s;
    const t = document.getElementById('login'); if (t) t.hidden = true;
    const who = document.querySelector('.who');
    if (who && !document.getElementById('sair')) {
      const b = document.createElement('button');
      b.id = 'sair'; b.textContent = 'Sair'; b.className = 'btn';
      b.style.cssText = 'background:none;border:0;color:var(--side-muted);text-decoration:underline;padding:2px 0;justify-self:start';
      b.onclick = async () => { await sb.auth.signOut(); location.reload(); };
      who.append(b);
      const c = document.createElement('button');
      c.id = 'senha'; c.textContent = 'Criar ou trocar senha'; c.className = 'btn';
      c.style.cssText = b.style.cssText;
      c.onclick = telaSenha;
      who.append(c);
    }
    abre();
  }
  addEventListener('DOMContentLoaded', () => {});
  window.__iniciaLogin = async () => {
    const { data } = await sb.auth.getSession();
    if (data.session) await entra(data.session); else telaLogin();
  };
  sb.auth.onAuthStateChange((ev, s) => { if (s) sessao = s; if (ev === 'SIGNED_OUT' && sessao) location.reload(); });
})();
