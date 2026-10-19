const NOTIFICATION_STORAGE_KEY = 'ropilot_task_completion_notifications';
const SOUND_STORAGE_KEY = 'ropilot_task_completion_sound';
const DEFAULT_NOTIFICATION_DURATION_MS = 10000;

export class TaskNotificationManager {
  constructor(app) {
    this.app = app;
    this.enabled = localStorage.getItem(NOTIFICATION_STORAGE_KEY) !== 'false';
    this.soundEnabled = localStorage.getItem(SOUND_STORAGE_KEY) !== 'false';
    this.isWindowHovered = true;
    this.isWindowFocused = true;
    this.activeNotification = null;
    this._bound = false;
  }

  bindWindowState() {
    if (this._bound || typeof window === 'undefined' || typeof document === 'undefined') return;

    this.isWindowFocused = this._readFocusState();
    this.isWindowHovered = this.isWindowFocused;

    window.addEventListener('focus', () => {
      this.isWindowFocused = true;
      this.isWindowHovered = true;
    });

    window.addEventListener('blur', () => {
      this.isWindowFocused = false;
    });

    window.addEventListener('mouseenter', () => {
      this.isWindowHovered = true;
    });

    window.addEventListener('mouseleave', () => {
      this.isWindowHovered = false;
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.isWindowFocused = false;
        this.isWindowHovered = false;
        return;
      }

      this.isWindowFocused = this._readFocusState();
    });

    this._bound = true;
  }

  setEnabled(nextValue) {
    this.enabled = !!nextValue;
    localStorage.setItem(NOTIFICATION_STORAGE_KEY, String(this.enabled));
  }

  setSoundEnabled(nextValue) {
    this.soundEnabled = !!nextValue;
    localStorage.setItem(SOUND_STORAGE_KEY, String(this.soundEnabled));
  }

  isSupported() {
    return typeof Notification === 'function';
  }

  async notifyTaskCompleted(chatId) {
    if (!chatId || !this.shouldNotifyForBackgroundCompletion()) {
      return false;
    }

    const context = this.getChatContext(chatId);
    const soundPlayed = await this.playCompletionSound();
    const notificationShown = await this.showNotification(chatId, context);

    return soundPlayed || notificationShown;
  }

  async showNotification(chatId, context = this.getChatContext(chatId)) {
    if (!this.enabled) {
      return false;
    }

    const permissionGranted = await this.ensurePermission();
    if (!permissionGranted) {
      return false;
    }

    const title = context?.chatTitle
      ? `${context.chatTitle} completed`
      : 'Ropilot task completed';
    const bodyParts = [];

    if (context?.projectName) {
      bodyParts.push(context.projectName);
    }
    bodyParts.push('The AI finished its task.');

    this.activeNotification?.close?.();

    const notification = new Notification(title, {
      body: bodyParts.join(' • '),
      icon: this.getIconUrl(),
      tag: `ropilot-task-complete-${chatId}`,
    });

    notification.onclick = () => {
      try {
        window.focus();
      } catch (_) {}

      if (context?.projectId) {
        void this.app.chatManager?.setActive(chatId, context.projectId);
      }

      notification.close?.();
    };

    this.activeNotification = notification;
    window.setTimeout(() => {
      if (this.activeNotification === notification) {
        this.activeNotification = null;
      }
      notification.close?.();
    }, DEFAULT_NOTIFICATION_DURATION_MS);

    return true;
  }

  async playCompletionSound() {
    if (!this.soundEnabled) {
      return false;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextCtor !== 'function') {
      return false;
    }

    let audioContext;
    try {
      audioContext = new AudioContextCtor();
      if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
        await audioContext.resume();
      }

      const now = audioContext.currentTime || 0;
      const gainNode = audioContext.createGain();
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
      gainNode.connect(audioContext.destination);

      const toneA = audioContext.createOscillator();
      toneA.type = 'sine';
      toneA.frequency.setValueAtTime(880, now);
      toneA.connect(gainNode);
      toneA.start(now);
      toneA.stop(now + 0.18);

      const toneB = audioContext.createOscillator();
      toneB.type = 'sine';
      toneB.frequency.setValueAtTime(1174.66, now + 0.18);
      toneB.connect(gainNode);
      toneB.start(now + 0.18);
      toneB.stop(now + 0.4);

      window.setTimeout(() => {
        try {
          audioContext.close?.();
        } catch (_) {}
      }, 500);

      return true;
    } catch (_) {
      try {
        audioContext?.close?.();
      } catch (_) {}
      return false;
    }
  }

  shouldNotifyForBackgroundCompletion() {
    if (typeof document !== 'undefined' && document.hidden) {
      return true;
    }

    return !this.isWindowFocused || !this.isWindowHovered;
  }

  async ensurePermission() {
    if (!this.isSupported()) return false;

    if (Notification.permission === 'granted') {
      return true;
    }

    if (Notification.permission === 'denied') {
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    } catch (_) {
      return false;
    }
  }

  getChatContext(chatId) {
    for (const project of this.app.projects || []) {
      const chat = Array.isArray(project?.chats)
        ? project.chats.find((candidate) => candidate?.id === chatId)
        : null;
      if (!chat) continue;

      return {
        projectId: project.id,
        projectName: project.name || 'Unnamed Project',
        chatTitle: chat.title || 'Untitled Chat',
      };
    }

    return null;
  }

  getIconUrl() {
    try {
      return new URL('./icon.png', window.location.href).href;
    } catch (_) {
      return undefined;
    }
  }

  _readFocusState() {
    try {
      return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    } catch (_) {
      return true;
    }
  }
}
