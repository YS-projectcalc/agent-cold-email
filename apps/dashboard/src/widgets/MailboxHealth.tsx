import { useInfrastructureStatus } from "../api/queries";
import { WidgetChrome } from "./WidgetChrome";
import { MailboxHealthTable } from "./MailboxHealthTable";
import type { WidgetOfType } from "./types";

export function MailboxHealth({ widget }: { widget: WidgetOfType<"mailbox_health"> }) {
  const { props } = widget;
  const query = useInfrastructureStatus(props.refreshSeconds);
  const mailboxes = query.data?.mailboxHealth ?? [];

  return (
    <WidgetChrome
      title={props.title ?? "Mailbox health"}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      isEmpty={query.isSuccess && mailboxes.length === 0}
      emptyMessage="No mailboxes provisioned yet."
    >
      <MailboxHealthTable mailboxes={mailboxes} showWarmup={props.showWarmup} />
    </WidgetChrome>
  );
}
