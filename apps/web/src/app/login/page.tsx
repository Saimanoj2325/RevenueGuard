'use client';
import { ArrowRight, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import LiveScene from '@/components/login/LiveScene';
import s from '@/components/login/live.module.css';
import { api } from '@/lib/api';
import { DemoSwitch } from '@/components/Shell';
import { useAuth, useAuthReady, useDemo } from '@/lib/store';

const DEMO = [
  { email: 'admin@demo.in', who: 'Aditi · Owner', note: 'connections, settings' },
  { email: 'ops@demo.in', who: 'Ravi · Accounts', note: 'runs cases, cannot approve' },
  { email: 'finance@demo.in', who: 'Meera · Finance', note: 'approves invoices' },
  { email: 'finance2@demo.in', who: 'Arjun · Finance 2', note: 'second approver above ₹1L' },
];

/** Scales the fixed 1300×820 live scene to fit the left panel. */
function ScaledStage() {
  const wrap = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.6);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setK(Math.min(el.clientWidth / 1300, el.clientHeight / 820));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={wrap} className={s.stageWrap}>
      <div className={s.stage} style={{ transform: `scale(${k})` }}><LiveScene /></div>
    </div>
  );
}

function Brand() {
  return <div className={s.brand}><span className={s.mark}><i /></span>RevenueGuard</div>;
}

export default function LoginPage() {
  const router = useRouter();
  const ready = useAuthReady();
  const { token, set } = useAuth();
  const demo = useDemo();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => { if (demo) { setEmail((e) => e || 'finance@demo.in'); setPassword((p) => p || 'demo1234'); } }, [demo]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (ready && token) router.replace('/'); }, [ready, token, router]);

  async function login(e?: string, p?: string) {
    const em = e ?? email;
    setBusy(em);
    setErr(null);
    try {
      const r = await api.login(em, p ?? password);
      set(r.token, r.user);
      router.replace('/');
    } catch (x: any) {
      setErr(x?.message ? 'Wrong email or password. Please try again.' : 'Could not sign in.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={s.page}>
      <section className={s.left} aria-label="How RevenueGuard works">
        <Brand />
        <h1 className={s.headline}>Delivered but <em>not billed?</em> We catch it, live.</h1>
        <p className={s.sub}>Reads your WhatsApp challans, emails, sheets and Zoho. Finds the money you forgot to bill. You approve every invoice, and it checks Zoho after.</p>
        <ScaledStage />
        <div className={s.foot}><span>Sample story: PO-184</span><span>You approve every invoice</span><span>Nothing is billed twice</span><span>Checked in Zoho after</span></div>
      </section>

      <section className={s.right}>
        <div className={s.signin}>
          <div className={s.mobileHead}><Brand /></div>
          <div className={s.sCard}>
            <div className={s.eyebrow}>Welcome back</div>
            <h2 className={s.sTitle}>Sign in</h2>
            <form onSubmit={(e) => { e.preventDefault(); login(); }}>
              <label className={s.field}>
                <span>Email</span>
                <input className={s.input} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.in" />
              </label>
              <label className={s.field}>
                <span>Password</span>
                <input className={s.input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              {err && <div className={s.err}>{err}</div>}
              <button className={s.btn} disabled={!!busy}>
                {busy === email ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />} Sign in
              </button>
            </form>

            {demo && (
              <>
                <div className={s.or}>Or try a demo user</div>
                <div className={s.demoGrid}>
                  {DEMO.map((d) => (
                    <button key={d.email} type="button" className={s.demo} disabled={!!busy} onClick={() => login(d.email, 'demo1234')}>
                      <div className={s.demoWho}>{d.who}{busy === d.email && <Loader2 size={12} className="animate-spin" />}</div>
                      <div className={s.demoNote}>{d.note}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3 text-[12.5px] text-ink-3">
              <span>{demo ? 'Demo mode: sample business, runs in your browser.' : 'Using your RevenueGuard server.'}</span>
              <DemoSwitch />
            </div>
            <div className={s.trust}><ShieldCheck size={15} style={{ flex: 'none', marginTop: 1 }} /> Your data stays in your account. Nothing is billed or sent without your approval.</div>
          </div>
        </div>
      </section>
    </div>
  );
}
