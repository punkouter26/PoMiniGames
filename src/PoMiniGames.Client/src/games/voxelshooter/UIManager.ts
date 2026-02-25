/**
 * Modern UI Management System
 * Adapted for embedded use within PoMiniGames — all DOM elements are appended to
 * a provided container element rather than document.body.
 */
import { qualitySettings } from './QualitySettings';
import type { QualityLevel } from './QualitySettings';

export class UIManager {
  private container: HTMLElement;

  private gameHUD: HTMLDivElement | null = null;
  private timerEl: HTMLDivElement | null = null;
  private progressBar: HTMLDivElement | null = null;
  private scoreEl: HTMLDivElement | null = null;
  private messageEl: HTMLDivElement | null = null;
  private objectiveEl: HTMLDivElement | null = null;
  private pauseMenu: HTMLDivElement | null = null;
  private settingsMenu: HTMLDivElement | null = null;
  private gameOverModal: HTMLDivElement | null = null;
  private mainMenu: HTMLDivElement | null = null;
  private qualityDisplay: HTMLDivElement | null = null;
  private hintTimeout: ReturnType<typeof setTimeout> | null = null;
  private difficulty: 'easy' | 'normal' | 'hard' = 'normal';
  private enemiesDestroyed = 0;

  public onStartGame: ((difficulty: string) => void) | null = null;
  public onResumeGame: (() => void) | null = null;
  public onMainMenu: (() => void) | null = null;
  public onSettings: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.showMainMenu();
    this.createSettingsIcon();
    this.setupQualityListener();
  }

  private setupQualityListener(): void {
    qualitySettings.subscribe((level: QualityLevel) => {
      this.updateQualityDisplay(level);
    });
  }

  private updateQualityDisplay(level: QualityLevel): void {
    if (this.qualityDisplay) {
      const levelMap: Record<QualityLevel, string> = {
        ultra: '4 ULTRA',
        high: '3 HIGH',
        medium: '2 MED',
        low: '1 LOW',
      };
      this.qualityDisplay.textContent = `GFX: ${levelMap[level]}`;
    }
  }

  // ===== MAIN MENU =====
  public showMainMenu(): void {
    this.clearAllMenus();

    this.mainMenu = document.createElement('div');
    this.mainMenu.className = 'menu-overlay';

    const content = document.createElement('div');
    content.className = 'menu-content';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'VOXEL DISINTEGRATOR';

    const subtitle = document.createElement('p');
    subtitle.className = 'menu-subtitle';
    subtitle.textContent = 'Survive 60 seconds. Click to shoot.';

    const qualityInfo = document.createElement('p');
    qualityInfo.style.cssText = `
      font-size: 12px;
      color: #00D9FF;
      margin-top: 20px;
      font-family: monospace;
    `;
    qualityInfo.textContent = 'Press 4/3/2/1 to change graphics quality';

    const buttons = document.createElement('div');
    buttons.className = 'menu-buttons';

    const startBtn = document.createElement('button');
    startBtn.className = 'menu-button menu-button-primary';
    startBtn.textContent = '▶ START';
    startBtn.onclick = () => this.startGame();

    buttons.appendChild(startBtn);

    content.appendChild(title);
    content.appendChild(subtitle);
    content.appendChild(qualityInfo);
    content.appendChild(buttons);

    this.mainMenu.appendChild(content);
    this.container.appendChild(this.mainMenu);
  }

  private startGame(): void {
    if (this.mainMenu) {
      this.mainMenu.style.display = 'none';
      this.mainMenu.remove();
      this.mainMenu = null;
    }

    this.difficulty = 'normal';

    this.createGameHUD();
    this.createSettingsIcon();

    const isMobile = () => window.innerWidth < 768 || navigator.maxTouchPoints > 2;
    if (isMobile()) {
      this.showHint('TAP TO SHOOT • SWIPE TO MOVE', 3000);
    } else {
      this.showHint('CLICK TO SHOOT • ESC TO PAUSE', 3000);
    }

    if (this.onStartGame) {
      this.onStartGame(this.difficulty);
    }
  }

  // ===== GAME HUD =====
  private createGameHUD(): void {
    this.gameHUD = document.createElement('div');
    this.gameHUD.className = 'game-hud';

    const panel = document.createElement('div');
    panel.className = 'hud-panel';

    this.timerEl = document.createElement('div');
    this.timerEl.className = 'timer-display';
    this.timerEl.textContent = '0s / 100s';

    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-bar-container';

    this.progressBar = document.createElement('div');
    this.progressBar.className = 'progress-bar-fill';
    progressContainer.appendChild(this.progressBar);

    const hudSection1 = document.createElement('div');
    hudSection1.className = 'hud-section';
    hudSection1.appendChild(this.timerEl);
    hudSection1.appendChild(progressContainer);

    this.objectiveEl = document.createElement('div');
    this.objectiveEl.className = 'objective-label';
    this.objectiveEl.textContent = 'ELIMINATE VOXELS • SURVIVE!';

    const hudSection2 = document.createElement('div');
    hudSection2.className = 'hud-section';
    hudSection2.appendChild(this.objectiveEl);

    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'score-display';
    this.scoreEl.textContent = 'ENEMIES: 0';

    const hudSection3 = document.createElement('div');
    hudSection3.className = 'hud-section';
    hudSection3.appendChild(this.scoreEl);

    this.qualityDisplay = document.createElement('div');
    this.qualityDisplay.className = 'quality-display';
    this.qualityDisplay.textContent = `GFX: 3 HIGH`;
    this.qualityDisplay.style.cssText = `
      position: absolute;
      top: 10px;
      right: 10px;
      font-size: 10px;
      color: #00D9FF;
      background: rgba(0, 20, 40, 0.8);
      padding: 5px 8px;
      border: 1px solid #00D9FF;
      border-radius: 3px;
      font-family: monospace;
      z-index: 1000;
    `;

    this.messageEl = document.createElement('div');
    this.messageEl.className = 'message-display';
    this.messageEl.innerHTML = '';

    panel.appendChild(hudSection1);
    panel.appendChild(hudSection2);
    panel.appendChild(hudSection3);

    this.gameHUD.appendChild(panel);
    this.gameHUD.appendChild(this.messageEl);
    this.container.appendChild(this.qualityDisplay);

    this.container.appendChild(this.gameHUD);
    this.createCrosshair();
  }

  private createCrosshair(): void {
    const crosshair = document.createElement('div');
    crosshair.className = 'crosshair';
    this.container.appendChild(crosshair);
  }

  public updateTimer(current: number, total: number): void {
    if (!this.timerEl || !this.progressBar) return;

    const percentage = (current / total) * 100;
    this.timerEl.textContent = `${current}s / ${total}s`;
    this.progressBar.style.width = percentage + '%';

    if (current > total * 0.4) {
      this.progressBar.classList.remove('critical');
    } else {
      this.progressBar.classList.add('critical');
    }
  }

  public setEnemiesDestroyed(count: number): void {
    this.enemiesDestroyed = count;
    if (this.scoreEl) {
      this.scoreEl.innerHTML = `🎯 ENEMIES: <span style="color: #00D9FF;">${count}</span>`;
    }
  }

  public setMessage(text: string, type: 'info' | 'success' | 'warning' = 'info'): void {
    if (!this.messageEl) return;

    const colorMap: Record<string, string> = {
      info: '#00D9FF',
      success: '#4ade80',
      warning: '#FF3366'
    };

    this.messageEl.innerHTML = text
      ? `<span style="color: ${colorMap[type]};">${text}</span>`
      : '';
  }

  public showHint(text: string, duration: number = 3000): void {
    if (this.hintTimeout) clearTimeout(this.hintTimeout);

    let hint = this.container.querySelector('.hint-message') as HTMLDivElement;
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'hint-message';
      this.container.appendChild(hint);
    }

    hint.classList.remove('fade-out');
    hint.textContent = text;
    hint.style.display = 'block';

    this.hintTimeout = setTimeout(() => {
      hint.classList.add('fade-out');
    }, duration);
  }

  // ===== PAUSE MENU =====
  public showPauseMenu(): void {
    if (this.pauseMenu) {
      this.pauseMenu.style.display = 'flex';
      return;
    }

    this.pauseMenu = document.createElement('div');
    this.pauseMenu.className = 'pause-menu';

    const content = document.createElement('div');
    content.className = 'pause-content';

    const title = document.createElement('div');
    title.className = 'pause-title';
    title.textContent = '⏸ PAUSED';

    const hint = document.createElement('div');
    hint.className = 'pause-hint';
    hint.textContent = 'Press ESC or P to Resume';

    const buttons = document.createElement('div');
    buttons.className = 'pause-buttons';

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'pause-button pause-button-primary';
    resumeBtn.textContent = '▶ RESUME';
    resumeBtn.onclick = () => this.hidePauseMenu();

    const menuBtn = document.createElement('button');
    menuBtn.className = 'pause-button';
    menuBtn.textContent = '🏠 BACK TO HOME';
    menuBtn.onclick = () => this.returnToMainMenu();

    buttons.appendChild(resumeBtn);
    buttons.appendChild(menuBtn);

    content.appendChild(title);
    content.appendChild(hint);
    content.appendChild(buttons);

    this.pauseMenu.appendChild(content);
    this.container.appendChild(this.pauseMenu);
  }

  public hidePauseMenu(): void {
    if (this.pauseMenu) {
      this.pauseMenu.style.display = 'none';
    }
    if (this.onResumeGame) {
      this.onResumeGame();
    }
  }

  // ===== SETTINGS OVERLAY =====
  private createSettingsIcon(): void {
    // Remove any existing settings icon first
    const existing = this.container.querySelector('.settings-icon');
    if (existing) existing.remove();

    const settingsIcon = document.createElement('button');
    settingsIcon.className = 'settings-icon';
    settingsIcon.textContent = '⚙️';
    settingsIcon.title = 'Settings';
    settingsIcon.onclick = () => this.toggleSettingsOverlay();
    this.container.appendChild(settingsIcon);
  }

  private toggleSettingsOverlay(): void {
    if (this.settingsMenu) {
      this.settingsMenu.style.display = this.settingsMenu.style.display === 'none' ? 'flex' : 'none';
      return;
    }

    this.settingsMenu = document.createElement('div');
    this.settingsMenu.className = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-header';
    const titleEl = document.createElement('h3');
    titleEl.textContent = '⚙ SETTINGS';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => this.hideSettingsOverlay();
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const graphicsGroup = document.createElement('div');
    graphicsGroup.className = 'settings-group';
    const graphicsLabel = document.createElement('label');
    graphicsLabel.className = 'settings-label';
    const graphicsText = document.createElement('span');
    graphicsText.textContent = 'Graphics Quality';
    const graphicsValue = document.createElement('span');
    graphicsValue.className = 'settings-value';
    graphicsValue.textContent = 'High';
    graphicsLabel.appendChild(graphicsText);
    graphicsLabel.appendChild(graphicsValue);
    graphicsGroup.appendChild(graphicsLabel);

    const graphicsSlider = document.createElement('input');
    graphicsSlider.type = 'range';
    graphicsSlider.className = 'settings-slider';
    graphicsSlider.min = '0';
    graphicsSlider.max = '2';
    graphicsSlider.value = '2';
    const qualityNames = ['Low', 'Medium', 'High'];
    graphicsSlider.onchange = (e: Event) => {
      const val = parseInt((e.target as HTMLInputElement).value);
      graphicsValue.textContent = qualityNames[val];
    };
    graphicsGroup.appendChild(graphicsSlider);

    panel.appendChild(header);
    panel.appendChild(graphicsGroup);

    this.settingsMenu.onclick = (e: MouseEvent) => {
      if (e.target === this.settingsMenu) this.hideSettingsOverlay();
    };

    this.settingsMenu.appendChild(panel);
    this.container.appendChild(this.settingsMenu);
  }

  private hideSettingsOverlay(): void {
    if (this.settingsMenu) {
      this.settingsMenu.style.display = 'none';
    }
  }

  // ===== GAME OVER / WIN MODALS =====
  public showGameOver(reason: string): void {
    const stats = `
      <div class="modal-stats">
        <strong>Enemies Destroyed:</strong> ${this.enemiesDestroyed}<br>
        <strong>Reason:</strong> ${reason}
      </div>
    `;

    this.gameOverModal = this.createModal(
      '💥 GAME OVER',
      `You were overwhelmed by the voxel chaos.${stats}`,
      ['PLAY AGAIN', 'BACK TO HOME']
    );

    const buttons = this.gameOverModal.querySelectorAll('.modal-button');
    (buttons[0] as HTMLButtonElement).classList.add('primary');
    (buttons[0] as HTMLButtonElement).onclick = () => {
      this.clearGameOver();
      if (this.onStartGame) this.onStartGame(this.difficulty);
    };
    (buttons[1] as HTMLButtonElement).onclick = () => this.returnToMainMenu();
  }

  public showWin(msg: string): void {
    const stats = `
      <div class="modal-stats">
        <strong>Enemies Destroyed:</strong> ${this.enemiesDestroyed}<br>
        <strong>Achievement:</strong> SURVIVAL VICTORY!
      </div>
    `;

    this.gameOverModal = this.createModal(
      '🎉 YOU WIN!',
      `${msg}${stats}`,
      ['PLAY AGAIN', 'BACK TO HOME']
    );

    this.gameOverModal.style.borderColor = '#4ade80';
    const title = this.gameOverModal.querySelector('.modal-title') as HTMLElement;
    if (title) title.style.color = '#4ade80';

    const buttons = this.gameOverModal.querySelectorAll('.modal-button');
    (buttons[0] as HTMLButtonElement).classList.add('primary');
    (buttons[0] as HTMLButtonElement).onclick = () => {
      this.clearGameOver();
      if (this.onStartGame) this.onStartGame(this.difficulty);
    };
    (buttons[1] as HTMLButtonElement).onclick = () => this.returnToMainMenu();
  }

  private createModal(
    title: string,
    message: string,
    buttonLabels: string[]
  ): HTMLDivElement {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const titleEl = document.createElement('h2');
    titleEl.className = 'modal-title';
    titleEl.textContent = title;

    const msgEl = document.createElement('div');
    msgEl.className = 'modal-message';
    msgEl.innerHTML = message;

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';

    buttonLabels.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.className = 'modal-button';
      if (i > 0) btn.classList.add('secondary');
      btn.textContent = label.toUpperCase();
      buttons.appendChild(btn);
    });

    content.appendChild(titleEl);
    content.appendChild(msgEl);
    content.appendChild(buttons);

    modal.appendChild(content);
    this.container.appendChild(modal);

    return modal;
  }

  private clearGameOver(): void {
    if (this.gameOverModal) {
      this.gameOverModal.remove();
      this.gameOverModal = null;
    }
  }

  private returnToMainMenu(): void {
    this.enemiesDestroyed = 0;

    if (this.gameHUD?.parentNode) this.gameHUD.parentNode.removeChild(this.gameHUD);
    this.clearAllMenus();

    if (this.onMainMenu) {
      // Delegate to external handler (e.g., navigate back to PoMiniGames home)
      this.onMainMenu();
    } else {
      this.showMainMenu();
    }
  }

  private clearAllMenus(): void {
    [this.pauseMenu, this.settingsMenu, this.gameOverModal, this.mainMenu].forEach(menu => {
      if (menu?.parentNode) menu.parentNode.removeChild(menu);
    });
    this.pauseMenu = null;
    this.settingsMenu = null;
    this.gameOverModal = null;
    this.mainMenu = null;
  }

  public clear(): void {
    this.clearAllMenus();
    if (this.gameHUD?.parentNode) this.gameHUD.parentNode.removeChild(this.gameHUD);
    if (this.qualityDisplay?.parentNode) this.qualityDisplay.parentNode.removeChild(this.qualityDisplay);
    const hint = this.container.querySelector('.hint-message');
    if (hint?.parentNode) hint.parentNode.removeChild(hint);
    const crosshair = this.container.querySelector('.crosshair');
    if (crosshair?.parentNode) crosshair.parentNode.removeChild(crosshair);
    const settingsIcon = this.container.querySelector('.settings-icon');
    if (settingsIcon?.parentNode) settingsIcon.parentNode.removeChild(settingsIcon);
    if (this.hintTimeout) clearTimeout(this.hintTimeout);
  }
}
