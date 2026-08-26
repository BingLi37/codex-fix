import { useState } from 'react';
import { Alert, Button, Modal } from '@heroui/react';
import { usePanel } from './usePanel';
import { StatusHeader } from './StatusHeader';
import { StatCards } from './StatCards';
import { Controls } from './Controls';
import { EventStream } from './EventStream';
import { ErrorPanel } from './ErrorPanel';
import { RelayDialog } from './RelayDialog';

// The banner is the one place that explains *why* traffic might not be flowing,
// which matters more than the running lamp on its own.
function Banner({ status, notice }) {
  if (notice) {
    return (
      <Alert status={notice.status}>
        <Alert.Indicator />
        <Alert.Content><Alert.Description>{notice.text}</Alert.Description></Alert.Content>
      </Alert>
    );
  }
  if (!status) return null;
  if (status.relayFallback) {
    const why = {
      corrupt: 'relays.json 内容不是合法 JSON',
      absent: '找不到 relays.json',
      empty: 'relays.json 里没有可用的中转站',
    }[status.relayFallback] ?? 'relays.json 有问题';
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>正在使用内置的默认中转站</Alert.Title>
          <Alert.Description>
            {why}，所以下面列出的不是你配置的那份。在「中转站」里重新保存一次即可修好；
            原文件若无法解析，会先备份成 relays.json.corrupt-*。
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (status.codex?.wired === false) {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Codex 没有走这个代理</Alert.Title>
          <Alert.Description>
            config.toml 里 base_url 目前是 {status.codex.baseUrl}，应为 {status.codex.expected}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (!status.running) {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>代理未运行</Alert.Title>
          <Alert.Description>Codex 现在无法连接模型，点上方的「启动」。</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  return null;
}

export default function App() {
  const panel = usePanel();
  const [filter, setFilter] = useState('all');
  const [autoscroll, setAutoscroll] = useState(true);
  const [showRelays, setShowRelays] = useState(false);

  return (
    // Fixed viewport height: only the two feeds scroll, so the controls can
    // never scroll out of reach.
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <StatusHeader status={panel.status} connected={panel.connected} />

      <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 px-6 py-5">
        <Controls
          status={panel.status}
          busy={panel.busy}
          act={panel.act}
          autoscroll={autoscroll}
          setAutoscroll={setAutoscroll}
          onClear={panel.clearEvents}
          showRelays={showRelays}
          setShowRelays={setShowRelays}
        />

        <Banner status={panel.status} notice={panel.notice} />
        <StatCards status={panel.status} />

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <EventStream
            events={panel.events}
            filter={filter}
            setFilter={setFilter}
            autoscroll={autoscroll}
          />
          <ErrorPanel events={panel.events} />
        </div>
      </main>

      <RelayDialog
        isOpen={showRelays}
        onClose={() => setShowRelays(false)}
        status={panel.status}
        relays={panel.status?.relays ?? []}
        active={panel.status?.active}
        act={panel.act}
        reload={panel.refresh}
      />

      {/* Container must nest inside Backdrop. As siblings, react-aria gives the
          Container its own overlay and the Backdrop renders a second, empty one
          that never gets dismissed — a black layer stuck over the page.
          Modal.CloseTrigger is also already a <button>, so no Button inside it. */}
      <Modal isOpen={Boolean(panel.modal)} onOpenChange={(open) => !open && panel.setModal(null)}>
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{panel.modal?.title}</Modal.Heading>
                <Modal.CloseTrigger aria-label="关闭弹窗" />
              </Modal.Header>
              <Modal.Body>
                <pre className="max-h-[60vh] overflow-auto rounded-xl bg-background-secondary p-3.5 font-mono text-[12px] whitespace-pre-wrap">
                  {panel.modal?.body || '(无输出)'}
                </pre>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="outline" onPress={() => panel.setModal(null)}>关闭</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
