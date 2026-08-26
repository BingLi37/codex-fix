import { useState } from 'react';
import { Button, Chip, Description, Input, Label, Modal, TextField } from '@heroui/react';

// Adding a relay only saves it. Switching to it stays a separate, deliberate step.
const BLANK = { id: '', name: '', baseUrl: '', apiKey: '', activate: false };

// TextField composes Label/Input/Description rather than taking them as props.
function Field({ label, hint, value, onChange, type }) {
  return (
    <TextField value={value} onChange={onChange} type={type} className="w-full">
      <Label>{label}</Label>
      <Input />
      <Description className="text-xs">{hint}</Description>
    </TextField>
  );
}

function RelayForm({ draft, setDraft, onCancel, onSave }) {
  const isNew = !draft.id;
  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-accent/40 bg-accent-soft/10 p-3.5">
      <Field
        label="名称"
        hint="随便起个好记的名字，比如 agentrouter、备用站"
        value={draft.name}
        onChange={(name) => setDraft({ ...draft, name })}
      />
      <Field
        label="Base URL"
        hint="填中转站原本要写进 Codex 的那个地址，例如 https://agentrouter.org/v1"
        value={draft.baseUrl}
        onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
      />
      <Field
        label="API Key"
        type="password"
        hint={isNew
          ? '可留空。留空时沿用 Codex 自己的 key（auth.json）'
          : '留空表示不修改已保存的 key'}
        value={draft.apiKey}
        onChange={(apiKey) => setDraft({ ...draft, apiKey })}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onPress={onCancel}>取消</Button>
        <Button variant="primary" size="sm" onPress={onSave}>
          保存
        </Button>
      </div>
    </div>
  );
}

export function RelayDialog({ isOpen, onClose, status, relays, active, act, reload }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const save = async () => {
    setError(null);
    const data = await post('/api/relays/save', draft);
    if (!data.ok) { setError(data.error); return; }
    setDraft(null);
    reload();
  };

  const switchTo = async (id) => { await post('/api/relays/activate', { id }); reload(); };

  const remove = async (relay) => {
    if (!window.confirm(`删除中转站「${relay.name}」？`)) return;
    const data = await post('/api/relays/delete', { id: relay.id });
    if (!data.ok) setError(data.error);
    reload();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) { setDraft(null); setError(null); onClose(); } }}>
      {/* Container nests inside Backdrop. As siblings, react-aria gives the
          Container its own overlay and Backdrop renders a second empty one that
          is never dismissed — a black layer left stuck over the page. */}
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog data-testid="relay-dialog">
            <Modal.Header>
              <Modal.Heading>中转站</Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭弹窗" />
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-3">
              <p className="text-xs text-muted">
                Codex 的 base_url 固定为{' '}
                <code className="rounded bg-background-secondary px-1.5 py-0.5 font-mono">
                  http://127.0.0.1:{status?.proxyPort ?? 7801}/v1
                </code>
                ，换中转站只在这里改，不用再动 config.toml。切换后立即生效，不需要重启。
              </p>

              {error && !draft && (
                <p className="rounded-lg bg-danger-soft/30 px-3 py-2 text-xs text-danger">{error}</p>
              )}

              {relays.map((relay) => {
                const isActive = relay.id === active;
                return (
                  <div
                    key={relay.id}
                    className={`flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 ${
                      isActive ? 'border-success/50 bg-success-soft/15' : 'border-border'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{relay.name}</span>
                        {isActive && (
                          <Chip color="success" variant="soft" size="sm"><Chip.Label>使用中</Chip.Label></Chip>
                        )}
                        <Chip variant="soft" size="sm">
                          <Chip.Label>{relay.hasApiKey ? '自带 key' : '用 Codex 的 key'}</Chip.Label>
                        </Chip>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{relay.baseUrl}</div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {!isActive && (
                        <Button variant="primary" size="sm" onPress={() => switchTo(relay.id)}>切换</Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => act('/api/relays/test', `连通性测试 · ${relay.name}`, { body: { id: relay.id } })}
                      >
                        测试
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => { setError(null); setDraft({ ...relay, apiKey: '', activate: false }); }}
                      >
                        编辑
                      </Button>
                      {relays.length > 1 && (
                        <Button variant="danger-soft" size="sm" onPress={() => remove(relay)}>删除</Button>
                      )}
                    </div>
                  </div>
                );
              })}

              {draft
                ? <RelayForm draft={draft} setDraft={setDraft} onCancel={() => setDraft(null)} onSave={save} />
                : (
                  <Button variant="outline" size="sm" onPress={() => { setError(null); setDraft({ ...BLANK }); }}>
                    添加中转站
                  </Button>
                )}
              {error && draft && <p className="text-xs text-danger">{error}</p>}
            </Modal.Body>

            <Modal.Footer>
              <Button variant="outline" onPress={onClose}>关闭</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
