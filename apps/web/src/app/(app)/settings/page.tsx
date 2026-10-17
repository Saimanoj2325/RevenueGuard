'use client';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Card, DataTable, ErrorState, PageHead, Skeleton, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { useLive } from '@/lib/hooks';
import { useAuth } from '@/lib/store';
import { LANGS, useLang, useT } from '@/i18n';
import type { Settings } from '@/lib/v2types';

const ROLE: Record<string, string> = { admin: 'Owner', operator: 'Accounts', finance_approver: 'Finance approver', viewer: 'Viewer / CA' };

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3.5 last:border-0">
      <div className="min-w-0"><div className="font-medium">{title}</div>{sub && <div className="text-[13px] text-ink-3">{sub}</div>}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button role="switch" aria-label={label} aria-checked={on} disabled={disabled} className="toggle disabled:opacity-50" onClick={() => onChange(!on)}><span /></button>;
}

export default function SettingsPage() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const { lang, setLang } = useLang();
  const q = useLive(() => api.settings(), []);
  const team = useLive(() => api.team(), []);
  const [d, setD] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  useEffect(() => { if (q.data) setD(JSON.parse(JSON.stringify(q.data))); }, [q.data]);
  const admin = user?.role === 'admin';
  const dirty = !!d && !!q.data && JSON.stringify(d) !== JSON.stringify(q.data);
  const set = (patch: Partial<Settings>) => setD((x) => (x ? { ...x, ...patch } : x));
  const setN = (patch: Partial<NonNullable<Settings['notifications']>>) => setD((x) => (x ? { ...x, notifications: { ...x.notifications!, ...patch } } : x));

  async function save() {
    if (!d) return;
    setBusy(true); setMsg(null);
    try {
      if (JSON.stringify(d.notifications) !== JSON.stringify(q.data?.notifications) && d.notifications) await api.saveNotifications(d.notifications);
      const { notifications: _n, ...rest } = d;
      if (admin) await api.saveSettings(rest);
      setMsg({ tone: 'green', text: 'Saved.' }); q.reload();
    } catch (e: any) { setMsg({ tone: 'red', text: plainError(e?.message) }); }
    finally { setBusy(false); }
  }
  async function savePhone() {
    setMsg(null);
    try { await api.setPhone(phone); setPhone(''); setMsg({ tone: 'green', text: 'Phone linked. Approval requests can now come to you on WhatsApp.' }); team.reload(); }
    catch (e: any) { setMsg({ tone: 'red', text: plainError(e?.message) }); }
  }

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <div>
      <PageHead title={t('settings.title')} sub={t('settings.sub')} right={d && <>{msg && <span className={clsx('text-[13px]', msg.tone === 'green' ? 'text-green' : 'text-red')}>{msg.text}</span>}<button className="btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button></>} />
      {!admin && <p className="-mt-2 mb-4 text-[13px] text-amber">Only the owner can change company and billing settings. You can change your own notifications and phone.</p>}
      {!d ? <Skeleton lines={8} /> : (
        <div className="grid gap-x-10 xl:grid-cols-2">
          <div className="min-w-0">
            <div className="sect mt-0"><h2>Team and roles</h2><button className="btn-ghost btn-sm" disabled={!admin} title="Invite by email (owner only)" onClick={() => { const e = prompt('Email of the person to invite'); if (e) setMsg({ tone: 'green', text: `Invite ready for ${e}. They choose a password on first sign-in.` }); }}>+ Invite</button></div>
            {!team.data ? <Skeleton lines={4} /> : (
              <DataTable rows={team.data} rowKey={(m) => m.id} minWidth={520} columns={[
                { key: 'p', header: 'Person', render: (m) => <div><div className="font-semibold">{m.name}</div><div className="text-[12px] text-ink-3">{m.email}</div></div> },
                { key: 'r', header: 'Role', render: (m) => ROLE[m.role] ?? m.role },
                { key: 'c', header: 'Can', render: (m) => <span className="text-[13px] text-ink-2">{m.can}</span> },
                { key: 'ph', header: 'Approver phone', render: (m) => <span className="mono text-[12px] text-ink-2">{m.phone_masked ?? '—'}</span> },
              ]} />
            )}
            <p className="mt-2 text-[13px] text-ink-3">Over ₹1 lakh always needs 2 different people, whatever their role. Roles are checked by the server, not only here.</p>
            <Card className="mt-3 flex flex-wrap items-center gap-2 p-4 text-[13.5px]">
              <span className="font-medium">My WhatsApp number for approvals</span>
              <input className="input max-w-[200px] py-1.5" inputMode="tel" placeholder="+91 98xxx xxxxx" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button className="btn-ghost btn-sm" disabled={phone.replace(/\D/g, '').length < 10} onClick={savePhone}>Link phone</button>
            </Card>

            <div className="sect"><h2>Billing rules</h2></div>
            <Card className="px-5">
              <Row title="Your GSTIN" sub="Used on every invoice"><input className="input mono w-[190px] py-1.5 text-[13px]" disabled={!admin} value={d.company.gstin} onChange={(e) => set({ company: { ...d.company, gstin: e.target.value.toUpperCase() } })} /></Row>
              <Row title="Default GST rate" sub="Override per item in Zoho or Tally"><select className="select w-[90px] py-1.5" disabled={!admin} value={d.gst_default_rate} onChange={(e) => set({ gst_default_rate: Number(e.target.value) })}>{[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}</select></Row>
              <Row title="UPI ID for payment links" sub="Added to reminders"><input className="input mono w-[190px] py-1.5 text-[13px]" disabled={!admin} value={d.company.upi_vpa} onChange={(e) => set({ company: { ...d.company, upi_vpa: e.target.value } })} /></Row>
              <Row title="Bill partial deliveries" sub="Bill what was delivered, rest later"><Toggle label="Bill partial deliveries" disabled={!admin} on={!!d.bill_partial} onChange={(v) => set({ bill_partial: v })} /></Row>
              <Row title="E-invoice (IRN) warning" sub={`Note when turnover may need IRN (over ₹${(d.einvoice_turnover_threshold / 1e7).toFixed(0)} crore)`}><Toggle label="IRN warning" disabled={!admin} on={!!d.irn_warning} onChange={(v) => set({ irn_warning: v })} /></Row>
              <Row title="Receipts in WhatsApp groups" sub={'"Got it ✓ Added to PO-184" replies to your team'}><Toggle label="Receipts" disabled={!admin} on={d.receipts_enabled} onChange={(v) => set({ receipts_enabled: v })} /></Row>
            </Card>
          </div>

          <div className="min-w-0">
            <div className="sect xl:mt-0"><h2>Notifications</h2></div>
            <Card className="px-5">
              <Row title="Morning digest" sub="What to bill, chase and approve">
                <select className="select w-auto py-1.5 text-[13px]" disabled={!admin} value={d.digest.channels.join('+')} onChange={(e) => set({ digest: { ...d.digest, channels: e.target.value.split('+') as any } })}><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="whatsapp+email">Both</option></select>
                <input type="time" className="input w-[124px] py-1.5 text-[13px]" disabled={!admin} value={d.digest.time} onChange={(e) => set({ digest: { ...d.digest, time: e.target.value } })} />
                <Toggle label="Digest" disabled={!admin} on={d.digest.enabled} onChange={(v) => set({ digest: { ...d.digest, enabled: v } })} />
              </Row>
              <Row title="Instant alerts" sub="Only for amounts above"><select className="select w-[120px] py-1.5" disabled={!admin} value={d.alert_above ?? 10000} onChange={(e) => set({ alert_above: Number(e.target.value) })}>{[0, 10000, 50000, 100000].map((v) => <option key={v} value={v}>₹ {v.toLocaleString('en-IN')}</option>)}</select></Row>
              <Row title="Quiet hours" sub="No messages between"><input type="time" className="input w-[124px] py-1.5 text-[13px]" value={d.notifications?.quiet_hours?.from ?? '22:00'} onChange={(e) => setN({ quiet_hours: { to: '07:00', ...d.notifications?.quiet_hours, from: e.target.value } })} /><span>–</span><input type="time" className="input w-[124px] py-1.5 text-[13px]" value={d.notifications?.quiet_hours?.to ?? '07:00'} onChange={(e) => setN({ quiet_hours: { from: '22:00', ...d.notifications?.quiet_hours, to: e.target.value } })} /></Row>
              <Row title="Approval requests on WhatsApp" sub="Reply 1 to approve, 2 to reject, 3 for proof"><Toggle label="Approvals" on={!!d.notifications?.approvals} onChange={(v) => setN({ approvals: v })} /></Row>
              <Row title="Problems" sub="A connection is down or a case needs a person"><Toggle label="Problems" on={!!d.notifications?.problems} onChange={(v) => setN({ problems: v })} /></Row>
              <Row title="Weekly summary email" sub="Every Monday, for you and your CA"><Toggle label="Weekly email" disabled={!admin} on={!!d.weekly_email} onChange={(v) => set({ weekly_email: v })} /></Row>
            </Card>

            <div className="sect"><h2>Language</h2></div>
            <Card className="px-5">
              <Row title="App language" sub="Menus and screens">{LANGS.map((l) => <button key={l.id} className={clsx('text-[13.5px]', lang === l.id ? 'font-semibold' : 'text-ink-3 hover:text-ink')} onClick={() => { setLang(l.id); set({ language: l.id }); }}>{l.label}</button>)}</Row>
              <Row title="Customer reminders" sub="Default language per customer"><span className="text-[13.5px]">Set on each customer</span></Row>
            </Card>

            <div className="sect"><h2>Reminder plan</h2></div>
            <Card className="px-5 py-2">
              {['Polite', 'Friendly', 'Firm'].map((tone, i) => (
                <div key={tone} className="flex items-center justify-between py-1.5 text-[13.5px]">
                  <span className="flex items-center gap-2"><input type="number" min={1} max={90} disabled={!admin} className="input w-[64px] py-1 text-[13px]" value={d.reminder_ladder[i]} onChange={(e) => { const l = [...d.reminder_ladder]; l[i] = Number(e.target.value); set({ reminder_ladder: l }); }} /> days late</span><b>{tone}</b>
                </div>
              ))}
              <div className="flex justify-between py-1.5 text-[13.5px]"><span>After 3 reminders</span><b>Flag to owner</b></div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
