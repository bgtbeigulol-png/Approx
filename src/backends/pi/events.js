import {
  captureMutation, contentText, finishMutation, firstFinite, messageText,
  modelToolGroupTitle, modelToolTitles, normalizeModel, stripToolTitleHeadings,
  summarizeArgs, toolTitle, unconsumedTitles,
} from './helpers.js';
import { buildFileChanges } from '../../file-changes.js';

export class PiEventMethods {
  onPiEvent(event) {
    switch (event.type) {
      case 'agent_start':
        this.assistantText = '';
        this.toolTitles = [];
        this.pendingToolTitles = [];
        this.pendingToolGroupTitle = '';
        this.emit({ type: 'busy' });
        break;
      case 'agent_settled':
        this.emitSettled();
        break;
      case 'message_update':
        this.onAssistantUpdate(event.assistantMessageEvent);
        break;
      case 'message_end':
        if (event.message?.role === 'assistant') this.endAssistant(event.message);
        if (event.message?.role === 'user') {
          const text = messageText(event.message);
          // AgentSession persists the message immediately after subscriber delivery.
          // A microtask observes the completed append and can attach its stable tree id.
          queueMicrotask(() => this.emitUserEntry(text));
        }
        break;
      case 'tool_execution_start':
        {
        const mutation = captureMutation(this.cwd, event.toolName, event.args);
        if (mutation) {
          mutation.callId = String(event.toolCallId);
          this.toolMutations.set(String(event.toolCallId), mutation);
        }
        const inlineTitles = modelToolTitles(this.assistantText);
        if (inlineTitles.length) this.pendingToolTitles.push(...unconsumedTitles(inlineTitles, this.toolTitles, this.pendingToolTitles));
        const modelTitle = this.pendingToolTitles.shift() || '';
        const groupTitle = modelToolGroupTitle(this.assistantText) || this.pendingToolGroupTitle;
        const groupHeading = groupTitle ? `Tool Calls: ${groupTitle}` : '';
        const fallbackTitle = toolTitle(event.toolName, event.args);
        const title = modelTitle || fallbackTitle;
        if (modelTitle) this.toolTitles.push(modelTitle);
        if (groupHeading) this.toolTitles.push(groupHeading);
        this.assistantText = '';
        this.pendingToolGroupTitle = '';
        this.emit({
          type: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          title,
          fallbackTitle,
          modelTitle: !!modelTitle,
          groupTitle,
          groupHeading,
          modelGroupTitle: !!groupTitle,
          meta: summarizeArgs(event.args),
          args: event.args,
        });
        break;
        }
      case 'tool_execution_update':
        this.emit({
          type: 'tool_update',
          id: event.toolCallId,
          text: contentText(event.partialResult?.content),
        });
        break;
      case 'tool_execution_end':
        {
        const mutation = finishMutation(this.toolMutations.get(String(event.toolCallId)));
        this.toolMutations.delete(String(event.toolCallId));
        if (mutation) {
          const callId = String(event.toolCallId);
          this.mutationJournal.set(callId, mutation);
          const manager = this.session?.sessionManager;
          const fileChanges = buildFileChanges([mutation], this.cwd);
          // Pi appends the tool result immediately after subscriber delivery.
          // Persist after that append so this UI-only entry remains on the same branch.
          queueMicrotask(() => {
            try {
              if (this.session?.sessionManager === manager) this.persistFileChanges(callId, fileChanges, manager);
            } catch {
              // A display-history write must not terminate the active model turn.
            }
          });
        }
        this.emit({
          type: 'tool_end',
          id: event.toolCallId,
          text: contentText(event.result?.content),
          isError: !!event.isError,
          mutation,
        });
        break;
        }
      case 'compaction_start':
        this.emit({
          type: 'compaction_start',
          reason: event.reason,
        });
        break;
      case 'compaction_end':
        this.emit({
          type: 'compaction_end',
          reason: event.reason,
          aborted: !!event.aborted,
          willRetry: !!event.willRetry,
          errorMessage: event.errorMessage || '',
          tokensBefore: event.result?.tokensBefore ?? null,
          estimatedTokensAfter: event.result?.estimatedTokensAfter ?? null,
        });
        this.emitContext();
        break;
      case 'auto_retry_start':
        this.emit({
          type: 'status',
          kind: 'warn',
          text: `Approx retry ${event.attempt}/${event.maxAttempts}`,
        });
        break;
      case 'auto_retry_end':
        if (!event.success) {
          this.emit({ type: 'error', error: event.finalError || 'Approx retry failed' });
        }
        break;
      case 'thinking_level_changed':
        this.emit({ type: 'effort', effort: event.level });
        break;
      default:
        break;
    }
  }

  emitSettled() {
    this.settledEventSeq = Number(this.settledEventSeq || 0) + 1;
    this.emitContext();
    this.emit({ type: 'settled' });
  }

  onAssistantUpdate(update) {
    if (!update) return;
    if (update.type === 'text_start') {
      this.ensureAssistant();
      return;
    }
    if (update.type === 'text_delta') {
      this.ensureAssistant();
      if (update.delta) {
        this.assistantText += update.delta;
        this.emit({ type: 'assistant_delta', delta: update.delta });
      }
      return;
    }
    if (update.type === 'thinking_start') {
      this.emit({ type: 'status', kind: 'info', text: 'Approx is working' });
    }
  }

  ensureAssistant() {
    if (this.assistantOpen) return;
    this.assistantOpen = true;
    this.emit({ type: 'assistant_start' });
  }

  endAssistant(message) {
    const rawText = messageText(message);
    const stopReason = String(message.stopReason ?? '');
    const trailingTitles = message.stopReason === 'toolUse' ? modelToolTitles(rawText) : [];
    const unseenTitles = unconsumedTitles(trailingTitles, this.toolTitles, this.pendingToolTitles);
    if (unseenTitles.length) this.pendingToolTitles.push(...unseenTitles);
    const trailingGroupTitle = message.stopReason === 'toolUse' ? modelToolGroupTitle(rawText) : '';
    if (trailingGroupTitle) this.pendingToolGroupTitle = trailingGroupTitle;
    const titles = [
      ...this.toolTitles,
      ...trailingTitles,
      ...(trailingGroupTitle ? [`Tool Calls: ${trailingGroupTitle}`] : []),
    ];
    const text = stripToolTitleHeadings(rawText, titles);
    // Always publish the structured end marker, even when a naming-only message
    // becomes empty after its heading is consumed. The UI uses stopReason, never
    // model prose, to distinguish intermediate toolUse notes from final delivery.
    if (text || this.assistantOpen) this.ensureAssistant();
    this.emit({ type: 'assistant_end', text, stopReason, final: stopReason.toLowerCase() !== 'tooluse' });
    this.assistantOpen = false;
    this.assistantText = '';
    this.toolTitles = [];

    if (message.stopReason === 'error' && message.errorMessage) {
      this.emit({ type: 'error', error: message.errorMessage });
    }
    if (message.usage) {
      const usage = message.usage;
      this.emit({
        type: 'usage',
        inputTokens: firstFinite(usage.input, usage.inputTokens, usage.promptTokens),
        outputTokens: firstFinite(usage.output, usage.outputTokens, usage.completionTokens),
        cacheReadTokens: firstFinite(usage.cacheRead, usage.cache_read, usage.cacheReadTokens, usage.cache?.read),
        cacheWriteTokens: firstFinite(usage.cacheWrite, usage.cache_write, usage.cacheWriteTokens, usage.cache?.write),
        cost: firstFinite(usage.cost?.total, usage.cost, usage.totalCost),
        model: normalizeModel(this.session?.model ?? {}).label,
        effort: this.session?.thinkingLevel || 'default',
      });
    }
    this.emitContext();
  }

  emitContext() {
    if (!this.session) return;
    const usage = this.session.getContextUsage();
    if (!usage) return;
    this.emit({
      type: 'context',
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    });
  }

  emitUserEntry(text) {
    if (!this.session) return;
    const entries = this.session.getUserMessagesForForking();
    const entry = [...entries].reverse().find((candidate) => !this.knownUserEntries.has(candidate.entryId)
      && candidate.text === text);
    if (!entry) return;
    this.knownUserEntries.add(entry.entryId);
    this.emit({ type: 'user_entry', entryId: entry.entryId, text: entry.text });
  }
}
