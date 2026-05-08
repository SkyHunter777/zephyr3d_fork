import {
  getDesktopAPI,
  type DesktopAssistantAttachment,
  type DesktopAssistantEvent,
  type DesktopAssistantMessage,
  type DesktopAssistantSessionSummary
} from './desktop';

export class AssistantService {
  static isAvailable() {
    return !!getDesktopAPI()?.settings;
  }

  static async createSession(title?: string): Promise<DesktopAssistantSessionSummary | null> {
    const desktop = getDesktopAPI();
    return desktop?.settings ? await desktop.settings.createAssistantSession(title) : null;
  }

  static async listSessions(): Promise<DesktopAssistantSessionSummary[]> {
    const desktop = getDesktopAPI();
    return desktop?.settings ? await desktop.settings.listAssistantSessions() : [];
  }

  static async getSessionMessages(sessionId: string): Promise<DesktopAssistantMessage[]> {
    const desktop = getDesktopAPI();
    return desktop?.settings ? await desktop.settings.getAssistantSessionMessages(sessionId) : [];
  }

  static async sendMessage(
    sessionId: string,
    content: string,
    attachments?: DesktopAssistantAttachment[]
  ): Promise<DesktopAssistantMessage | null> {
    const desktop = getDesktopAPI();
    return desktop?.settings
      ? await desktop.settings.sendAssistantMessage(sessionId, content, attachments)
      : null;
  }

  static async pickImageAttachment(): Promise<DesktopAssistantAttachment | null> {
    const desktop = getDesktopAPI();
    if (!desktop?.fs?.pickFile) {
      return null;
    }
    const picked = await desktop.fs.pickFile({
      title: 'Select Reference Image',
      buttonLabel: 'Attach Image',
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
        }
      ]
    });
    if (!picked || !picked.mimeType.startsWith('image/')) {
      return null;
    }
    return {
      id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: picked.name,
      mimeType: picked.mimeType,
      dataUrl: `data:${picked.mimeType};base64,${picked.dataBase64}`
    };
  }

  static async cancelRun(sessionId: string): Promise<boolean> {
    const desktop = getDesktopAPI();
    return desktop?.settings ? await desktop.settings.cancelAssistantRun(sessionId) : false;
  }

  static async approveToolCall(sessionId: string, callId: string): Promise<boolean> {
    const desktop = getDesktopAPI();
    return desktop?.settings ? await desktop.settings.approveAssistantToolCall(sessionId, callId) : false;
  }

  static async rejectToolCall(sessionId: string, callId: string): Promise<boolean> {
    const desktop = getDesktopAPI();
    return desktop?.settings ? await desktop.settings.rejectAssistantToolCall(sessionId, callId) : false;
  }

  static onEvent(listener: (event: DesktopAssistantEvent) => void): () => void {
    const desktop = getDesktopAPI();
    return desktop?.settings ? desktop.settings.onAssistantEvent(listener) : () => {};
  }
}
