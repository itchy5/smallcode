// SmallCode — Full-Screen TUI Runtime
// Zero-dependency alternate-buffer terminal UI
// Uses raw ANSI escape sequences for full terminal control
//
// How it works (same technique as OpenCode/Bubble Tea/vim):
// 1. Enter alternate screen buffer (\x1b[?1049h)
// 2. Enable raw mode (keypresses come in as raw bytes)
// 3. Maintain a virtual framebuffer (2D array of cells)
// 4. On each render, diff the framebuffer and write only changed cells
// 5. On exit, restore the original terminal (\x1b[?1049l)

const readline = require('readline');

// ─── ANSI Escape Sequences ───────────────────────────────────────────────────

const ESC = '\x1b[';
const ANSI = {
  // Screen buffer
  enterAlt: '\x1b[?1049h',
  leaveAlt: '\x1b[?1049l',
  // Cursor
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  moveTo: (row, col) => `${ESC}${row};${col}H`,
  // Erase
  clearScreen: `${ESC}2J`,
  clearLine: `${ESC}2K`,
  // Scroll region
  setScrollRegion: (top, bottom) => `${ESC}${top};${bottom}r`,
  resetScrollRegion: `${ESC}r`,
  // Style
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  // Colors (256-color)
  fg: (n) => `${ESC}38;5;${n}m`,
  bg: (n) => `${ESC}48;5;${n}m`,
  // Named colors
  fgRgb: (r, g, b) => `${ESC}38;2;${r};${g};${b}m`,
  bgRgb: (r, g, b) => `${ESC}48;2;${r};${g};${b}m`,
};

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEMES = {
  dark: {
    bg: ANSI.bgRgb(15, 15, 15),
    fg: ANSI.fgRgb(190, 190, 195),
    accent: ANSI.fgRgb(180, 180, 185),
    muted: ANSI.fgRgb(90, 90, 100),
    success: ANSI.fgRgb(140, 200, 140),
    error: ANSI.fgRgb(220, 90, 90),
    warning: ANSI.fgRgb(220, 180, 80),
    border: ANSI.fgRgb(50, 50, 55),
    statusBg: ANSI.bgRgb(20, 20, 22),
    inputBg: ANSI.bgRgb(18, 18, 20),
    brand: ANSI.fgRgb(220, 220, 225),       // bright silver for logo
    brandDim: ANSI.fgRgb(120, 120, 130),    // dimmer silver
    cmdHighlight: ANSI.fgRgb(160, 140, 200), // subtle purple for commands
  },
  light: {
    bg: ANSI.bgRgb(250, 250, 252),
    fg: ANSI.fgRgb(30, 30, 40),
    accent: ANSI.fgRgb(60, 60, 70),
    muted: ANSI.fgRgb(140, 140, 160),
    success: ANSI.fgRgb(20, 160, 60),
    error: ANSI.fgRgb(200, 40, 40),
    warning: ANSI.fgRgb(180, 130, 0),
    border: ANSI.fgRgb(200, 200, 210),
    statusBg: ANSI.bgRgb(235, 235, 240),
    inputBg: ANSI.bgRgb(245, 245, 248),
    brand: ANSI.fgRgb(40, 40, 50),
    brandDim: ANSI.fgRgb(120, 120, 130),
    cmdHighlight: ANSI.fgRgb(100, 80, 160),
  },
  minimal: {
    bg: '',
    fg: '',
    accent: ANSI.fg(250),
    muted: ANSI.fg(242),
    success: ANSI.fg(78),
    error: ANSI.fg(196),
    warning: ANSI.fg(214),
    border: ANSI.fg(236),
    statusBg: ANSI.bg(233),
    inputBg: ANSI.bg(234),
    brand: ANSI.fg(255),
    brandDim: ANSI.fg(245),
    cmdHighlight: ANSI.fg(141),
  },
};

// ─── Box Drawing ─────────────────────────────────────────────────────────────

const BOX = {
  topLeft: '┌', topRight: '┐',
  bottomLeft: '└', bottomRight: '┘',
  horizontal: '─', vertical: '│',
  teeLeft: '├', teeRight: '┤',
  teeTop: '┬', teeBottom: '┴',
  cross: '┼',
  // Rounded
  rTopLeft: '╭', rTopRight: '╮',
  rBottomLeft: '╰', rBottomRight: '╯',
};

// ─── Full-Screen TUI Class ───────────────────────────────────────────────────

class FullScreenTUI {
  constructor(options = {}) {
    this.theme = THEMES[options.theme || 'dark'];
    this.showToolPanel = options.showToolPanel || false;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    // Panel content buffers
    this.chatLines = [];         // Rendered chat messages
    this.toolLines = [];         // Tool execution log
    this.inputBuffer = '';       // Current user input
    this.inputCursor = 0;       // Cursor position in input
    this.chatScroll = 0;        // Scroll offset for chat
    this.inputHistory = [];     // Command history
    this.historyIdx = -1;

    // Command palette
    this.commandPaletteOpen = false;
    this.commandPaletteSelection = 0;
    this.commands = [
      { cmd: '/quit', alias: '/q', desc: 'Exit SmallCode' },
      { cmd: '/clear', alias: null, desc: 'Reset conversation' },
      { cmd: '/model', alias: null, desc: 'Show/switch model' },
      { cmd: '/endpoint', alias: null, desc: 'Switch API endpoint' },
      { cmd: '/stats', alias: null, desc: 'Session statistics' },
      { cmd: '/files', alias: null, desc: 'List project files' },
      { cmd: '/diff', alias: null, desc: 'Git diff summary' },
      { cmd: '/git', alias: null, desc: 'Run git command' },
      { cmd: '/loop', alias: null, desc: 'Validate + auto-fix file' },
      { cmd: '/memory', alias: null, desc: 'View project memory' },
      { cmd: '/escalation', alias: null, desc: 'Model escalation status' },
      { cmd: '/skill', alias: null, desc: 'Manage reusable skills' },
      { cmd: '/plugin', alias: null, desc: 'Manage plugins' },
      { cmd: '/sessions', alias: null, desc: 'List/resume sessions' },
      { cmd: '/session', alias: null, desc: 'Parallel sessions' },
      { cmd: '/share', alias: null, desc: 'Export session' },
      { cmd: '/undo', alias: null, desc: 'Revert last edit' },
      { cmd: '/compact', alias: null, desc: 'Trim conversation history' },
      { cmd: '/help', alias: null, desc: 'Show all commands' },
      { cmd: '/version', alias: null, desc: 'Show SmallCode version' },
    ];

    // Layout dimensions (computed)
    this.statusHeight = 1;
    this.inputHeight = 3;
    this.chatHeight = 0;
    this.chatWidth = 0;
    this.toolWidth = 0;

    // State
    this.active = false;
    this.model = options.model || 'unknown';
    this.tokenCount = 0;
    this.msgCount = 0;
    this.isStreaming = false;
    this.showWelcome = true; // Show splash on first render

    // Callbacks
    this.onSubmit = options.onSubmit || (() => {});
    this.onCommand = options.onCommand || (() => {});
    this.onExit = options.onExit || (() => {});

    this._computeLayout();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  enter() {
    this.active = true;

    // Store a direct reference to the real stdout.write (before any overrides)
    this._rawWrite = process.stdout.write.bind(process.stdout);

    // Enter alternate buffer + raw mode + enable button-event mouse tracking (allows text selection) + SGR encoding + bracketed paste
    this._rawWrite(ANSI.enterAlt + ANSI.hideCursor + '\x1b[?1002h' + '\x1b[?1006h' + '\x1b[?2004h');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Handle resize
    process.stdout.on('resize', () => this._onResize());

    // Handle raw keypresses
    process.stdin.on('data', (data) => this._onKeypress(data));

    this._computeLayout();
    this.render();
  }

  leave() {
    this.active = false;
    const write = this._rawWrite || process.stdout.write.bind(process.stdout);
    write(ANSI.showCursor + '\x1b[?1002l' + '\x1b[?1006l' + '\x1b[?2004l' + ANSI.leaveAlt + ANSI.reset);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // ─── Layout ──────────────────────────────────────────────────────────

  _computeLayout() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    // Dynamic input height: grows with content (min 3, max 8 lines)
    const inputAvail = this.width - 5;
    const wrappedLines = inputAvail > 0 ? Math.ceil(Math.max(1, this.inputBuffer.length) / inputAvail) : 1;
    this.inputHeight = Math.min(8, Math.max(3, wrappedLines + 2)); // +2 for border + hint

    this.chatHeight = this.height - this.inputHeight - this.statusHeight;

    if (this.showToolPanel && this.width > 100) {
      this.chatWidth = Math.floor(this.width * 0.65);
      this.toolWidth = this.width - this.chatWidth - 1;
    } else {
      this.chatWidth = this.width;
      this.toolWidth = 0;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  render() {
    if (!this.active) return;
    this._computeLayout(); // Recalculate in case input grew/shrunk

    let buf = '';

    // Clear
    buf += ANSI.clearScreen + ANSI.moveTo(1, 1);

    // Chat panel
    buf += this._renderChatPanel();

    // Tool panel (if split)
    if (this.toolWidth > 0) {
      buf += this._renderToolPanel();
    }

    // Input area
    buf += this._renderInput();

    // Status bar
    buf += this._renderStatus();

    // Position cursor in wrapped input
    const inputAvail = this.width - 5;
    const cursorLine = Math.floor(this.inputCursor / inputAvail); // which wrapped line
    const cursorCol = this.inputCursor % inputAvail; // position within that line
    const inputRow = this.chatHeight + 2 + cursorLine; // +1 border, +1 for 1-index
    const inputCol = 5 + cursorCol; // "│ > " prefix
    buf += ANSI.moveTo(inputRow, inputCol) + ANSI.showCursor;

    this._rawWrite(buf);
  }

  _renderChatPanel() {
    let buf = '';

    // Show welcome splash when no messages yet
    if (this.showWelcome && this.chatLines.length === 0) {
      return this._renderWelcomeScreen();
    }

    const startLine = Math.max(0, this.chatLines.length - this.chatHeight + this.chatScroll);
    const endLine = startLine + this.chatHeight;
    const visible = this.chatLines.slice(startLine, endLine);

    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, 1);
      const line = visible[i] || '';
      // Truncate to panel width
      buf += this._truncate(line, this.chatWidth);
      // Clear rest of line
      buf += ' '.repeat(Math.max(0, this.chatWidth - this._stripAnsi(line).length));
    }

    return buf;
  }

  _renderWelcomeScreen() {
    let buf = '';
    const w = this.chatWidth;
    const h = this.chatHeight;
    const t = this.theme;

    // ASCII logo — block style
    const logo = [
      '███████╗███╗   ███╗ █████╗ ██╗     ██╗      ██████╗ ██████╗ ██████╗ ███████╗',
      '██╔════╝████╗ ████║██╔══██╗██║     ██║     ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
      '███████╗██╔████╔██║███████║██║     ██║     ██║     ██║   ██║██║  ██║█████╗  ',
      '╚════██║██║╚██╔╝██║██╔══██║██║     ██║     ██║     ██║   ██║██║  ██║██╔══╝  ',
      '███████║██║ ╚═╝ ██║██║  ██║███████╗███████╗╚██████╗╚██████╔╝██████╔╝███████╗',
      '╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
    ];

    // Use simpler logo if terminal is narrow
    const simpleLogo = [
      '╔═╗┌┬┐┌─┐┬  ┬  ╔═╗┌─┐┌┬┐┌─┐',
      '╚═╗│││├─┤│  │  ║  │ │ ││├┤ ',
      '╚═╝┴ ┴┴ ┴┴─┘┴─┘╚═╝└─┘─┴┘└─┘',
    ];

    const useSimple = w < 80;
    const logoLines = useSimple ? simpleLogo : logo;
    const logoWidth = logoLines[0].length;

    // Center vertically — logo starts ~1/4 down the screen
    const startRow = Math.max(2, Math.floor(h * 0.15));

    // Draw logo centered
    for (let i = 0; i < logoLines.length; i++) {
      const row = startRow + i;
      if (row > h) break;
      const pad = Math.max(0, Math.floor((w - logoWidth) / 2));
      buf += ANSI.moveTo(row, 1);
      buf += ' '.repeat(pad) + t.brand + logoLines[i] + ANSI.reset;
    }

    // Version below logo
    const versionRow = startRow + logoLines.length + 1;
    const versionText = `v0.2.0`;
    const versionPad = Math.max(0, Math.floor((w - logoWidth) / 2) + logoWidth - versionText.length);
    buf += ANSI.moveTo(versionRow, versionPad + 1);
    buf += t.muted + versionText + ANSI.reset;

    // Command hints (centered block)
    const commands = [
      ['/help', 'show help', 'ctrl+l'],
      ['/model', 'switch model', ''],
      ['/memory', 'project memory', ''],
      ['/skill', 'manage skills', ''],
      ['/quit', 'exit', 'ctrl+c'],
    ];

    const cmdStartRow = versionRow + 3;
    for (let i = 0; i < commands.length; i++) {
      const [cmd, desc, shortcut] = commands[i];
      const row = cmdStartRow + i;
      if (row > h) break;
      const line = `${cmd.padEnd(12)} ${desc.padEnd(18)} ${shortcut}`;
      const pad = Math.max(0, Math.floor((w - 42) / 2));
      buf += ANSI.moveTo(row, pad + 1);
      buf += (t.cmdHighlight || t.accent) + cmd.padEnd(12) + ANSI.reset;
      buf += t.fg + desc.padEnd(18) + ANSI.reset;
      buf += t.muted + shortcut + ANSI.reset;
    }

    // Model info below commands
    const infoRow = cmdStartRow + commands.length + 2;
    if (infoRow < h) {
      const infoText = `${this.model}`;
      const infoPad = Math.max(0, Math.floor((w - infoText.length) / 2));
      buf += ANSI.moveTo(infoRow, infoPad + 1);
      buf += t.brandDim + infoText + ANSI.reset;
    }

    return buf;
  }

  _renderToolPanel() {
    if (this.toolWidth <= 0) return '';
    let buf = '';
    const col = this.chatWidth + 1;

    // Divider
    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, col);
      buf += this.theme.border + BOX.vertical + ANSI.reset;
    }

    // Tool log content
    const startLine = Math.max(0, this.toolLines.length - this.chatHeight);
    const visible = this.toolLines.slice(startLine, startLine + this.chatHeight);

    for (let i = 0; i < this.chatHeight; i++) {
      buf += ANSI.moveTo(i + 1, col + 1);
      const line = visible[i] || '';
      buf += this._truncate(line, this.toolWidth - 1);
    }

    return buf;
  }

  _renderInput() {
    let buf = '';
    const row = this.chatHeight + 1;
    const t = this.theme;

    // Command palette (floating above input when typing a slash command)
    if (this.commandPaletteOpen) {
      buf += this._renderCommandPalette(row);
    }

    // Thin separator line
    buf += ANSI.moveTo(row, 1);
    buf += t.border + BOX.horizontal.repeat(this.width) + ANSI.reset;

    // Input area — wraps vertically for long text
    const inputAvail = this.width - 5; // "│ > " prefix / "│   " continuation
    const inputLines = [];
    
    // Word-wrap the input buffer into lines
    if (this.inputBuffer.length === 0) {
      inputLines.push('');
    } else {
      for (let i = 0; i < this.inputBuffer.length; i += inputAvail) {
        inputLines.push(this.inputBuffer.slice(i, i + inputAvail));
      }
    }

    // Render each wrapped line
    for (let i = 0; i < inputLines.length && i < 6; i++) {
      buf += ANSI.moveTo(row + 1 + i, 1);
      buf += t.inputBg + t.border + BOX.vertical + ANSI.reset + t.inputBg;
      if (i === 0) {
        buf += t.muted + ' > ' + ANSI.reset + t.inputBg + t.fg;
      } else {
        buf += '   ' + t.inputBg + t.fg;
      }
      buf += inputLines[i];
      buf += ' '.repeat(Math.max(0, inputAvail - inputLines[i].length));
      buf += ANSI.reset;
    }

    // Clear remaining input area lines
    for (let i = inputLines.length; i < this.inputHeight - 2; i++) {
      buf += ANSI.moveTo(row + 1 + i, 1);
      buf += ' '.repeat(this.width);
    }

    // Hint line
    const hintRow = row + this.inputHeight - 1;
    buf += ANSI.moveTo(hintRow, 1);
    if (this.commandPaletteOpen) {
      buf += t.muted + '  ↑↓ navigate  enter select  esc cancel' + ANSI.reset;
    } else if (inputLines.length > 1) {
      buf += t.muted + `  ${this.inputBuffer.length} chars` + ANSI.reset;
    } else {
      buf += t.muted + '' + ANSI.reset;
    }

    return buf;
  }

  _renderCommandPalette(inputRow) {
    let buf = '';
    const filter = this.inputBuffer.slice(1).toLowerCase(); // Remove leading /
    const filtered = this.commands.filter(c =>
      c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
    );

    if (filtered.length === 0) return '';

    // Clamp selection
    this.commandPaletteSelection = Math.max(0, Math.min(this.commandPaletteSelection, filtered.length - 1));

    // Calculate palette dimensions
    const maxVisible = Math.min(filtered.length, 10);
    const paletteWidth = Math.min(this.width - 4, 50);
    const startRow = inputRow - maxVisible - 1;

    // Draw palette box
    buf += ANSI.moveTo(startRow, 2);
    buf += this.theme.border + BOX.rTopLeft + BOX.horizontal.repeat(paletteWidth - 2) + BOX.rTopRight + ANSI.reset;

    for (let i = 0; i < maxVisible; i++) {
      const cmd = filtered[i];
      const isSelected = i === this.commandPaletteSelection;
      const row = startRow + 1 + i;

      buf += ANSI.moveTo(row, 2);
      buf += this.theme.border + BOX.vertical + ANSI.reset;

      if (isSelected) {
        buf += ANSI.inverse;
      }

      const cmdText = cmd.cmd + (cmd.alias ? ` (${cmd.alias})` : '');
      const descText = cmd.desc;
      const line = ` ${cmdText.padEnd(16)} ${descText}`;
      buf += (isSelected ? this.theme.accent : this.theme.fg) + line.slice(0, paletteWidth - 3).padEnd(paletteWidth - 3);

      if (isSelected) {
        buf += ANSI.reset;
      }

      buf += ANSI.reset + this.theme.border + BOX.vertical + ANSI.reset;
    }

    buf += ANSI.moveTo(startRow + maxVisible + 1, 2);
    buf += this.theme.border + BOX.rBottomLeft + BOX.horizontal.repeat(paletteWidth - 2) + BOX.rBottomRight + ANSI.reset;

    return buf;
  }

  _renderStatus() {
    let buf = '';
    const row = this.height;
    const t = this.theme;

    buf += ANSI.moveTo(row, 1);
    buf += t.statusBg;

    const left = ` enter send`;
    const scrollInfo = this.chatScroll < 0 ? `  ↑ scrolled` : '';
    const tokenStr = this.tokenInfo ? `  ${this.tokenInfo}` : '';
    const right = ` smallcode  ${this.model}  ${this.isStreaming ? '⟳' : '●'} `;
    const padding = this.width - left.length - scrollInfo.length - tokenStr.length - right.length;

    buf += t.muted + left + ANSI.reset + t.statusBg;
    if (scrollInfo) {
      buf += (t.warning || t.muted) + scrollInfo + ANSI.reset + t.statusBg;
    }
    buf += t.muted + tokenStr + ANSI.reset + t.statusBg;
    buf += ' '.repeat(Math.max(1, padding));
    buf += t.brandDim + right + ANSI.reset;

    return buf;
  }

  // ─── Input Handling ──────────────────────────────────────────────────

  async _onKeypress(data) {
    const key = data.toString();

    // Bracketed paste detection — strip paste markers and handle as text
    if (key.includes('\x1b[200~')) {
      const cleaned = key.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      if (cleaned.length > 0) {
        const printable = cleaned.split('').filter(c => c.charCodeAt(0) >= 32 || c === '\n').join('');
        // Replace newlines with spaces for single-line input
        const text = printable.replace(/\n/g, ' ');
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += text.length;
        this.commandPaletteOpen = this.inputBuffer.startsWith('/');
        this.render();
      }
      return;
    }

    // Ctrl+C — exit
    if (key === '\x03') {
      this.leave();
      this.onExit();
      return;
    }

    // Ctrl+D — exit
    if (key === '\x04') {
      this.leave();
      this.onExit();
      return;
    }

    // Enter — submit
    if (key === '\r' || key === '\n') {
      // If command palette is open, select and execute immediately
      if (this.commandPaletteOpen) {
        const filter = this.inputBuffer.slice(1).toLowerCase();
        const filtered = this.commands.filter(c =>
          c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
        );
        if (filtered.length > 0) {
          const selected = filtered[Math.min(this.commandPaletteSelection, filtered.length - 1)];
          this.inputBuffer = selected.cmd;
          this.inputCursor = this.inputBuffer.length;
        }
        this.commandPaletteOpen = false;
        this.commandPaletteSelection = 0;
        // Fall through to execute the command below (don't return)
      }

      const input = this.inputBuffer.trim();
      if (input) {
        this.inputHistory.push(input);
        this.historyIdx = this.inputHistory.length;
        this.inputBuffer = '';
        this.inputCursor = 0;

        if (input.startsWith('/')) {
          await this.onCommand(input);
        } else {
          this.addChat('user', input);
          await this.onSubmit(input);
        }
      }
      this.render();
      return;
    }

    // Escape — close command palette
    if (key === '\x1b' && this.commandPaletteOpen) {
      this.commandPaletteOpen = false;
      this.commandPaletteSelection = 0;
      this.render();
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (this.inputCursor > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - 1) + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor--;
      }
      // Update command palette state
      if (this.inputBuffer.startsWith('/') && this.inputBuffer.length > 0) {
        this.commandPaletteOpen = true;
      } else {
        this.commandPaletteOpen = false;
        this.commandPaletteSelection = 0;
      }
      this.render();
      return;
    }

    // Arrow keys (escape sequences)
    if (key === '\x1b[A') { // Up — history or palette navigation
      if (this.commandPaletteOpen) {
        this.commandPaletteSelection = Math.max(0, this.commandPaletteSelection - 1);
        this.render();
        return;
      }
      if (this.historyIdx > 0) {
        this.historyIdx--;
        this.inputBuffer = this.inputHistory[this.historyIdx] || '';
        this.inputCursor = this.inputBuffer.length;
      }
      this.render();
      return;
    }
    if (key === '\x1b[B') { // Down — history or palette navigation
      if (this.commandPaletteOpen) {
        this.commandPaletteSelection++;
        this.render();
        return;
      }
      if (this.historyIdx < this.inputHistory.length - 1) {
        this.historyIdx++;
        this.inputBuffer = this.inputHistory[this.historyIdx] || '';
      } else {
        this.historyIdx = this.inputHistory.length;
        this.inputBuffer = '';
      }
      this.inputCursor = this.inputBuffer.length;
      this.render();
      return;
    }
    if (key === '\x1b[C') { // Right
      if (this.inputCursor < this.inputBuffer.length) this.inputCursor++;
      this.render();
      return;
    }
    if (key === '\x1b[D') { // Left
      if (this.inputCursor > 0) this.inputCursor--;
      this.render();
      return;
    }

    // Scroll chat — PgUp/PgDn, Shift+Up/Down, mouse wheel
    if (key === '\x1b[5~' || key === '\x1b[1;2A') { // PgUp or Shift+Up
      const maxBack = -(Math.max(0, this.chatLines.length - this.chatHeight));
      const step = key === '\x1b[1;2A' ? 3 : Math.floor(this.chatHeight / 2);
      this.chatScroll = Math.max(maxBack, this.chatScroll - step);
      this.render();
      return;
    }
    if (key === '\x1b[6~' || key === '\x1b[1;2B') { // PgDn or Shift+Down
      const step = key === '\x1b[1;2B' ? 3 : Math.floor(this.chatHeight / 2);
      this.chatScroll = Math.min(0, this.chatScroll + step);
      this.render();
      return;
    }
    // Mouse wheel (SGR mouse mode — \x1b[<64;x;yM = scroll up, \x1b[<65;x;yM = scroll down)
    if (key.startsWith('\x1b[<64;')) {
      const maxBack = -(Math.max(0, this.chatLines.length - this.chatHeight));
      this.chatScroll = Math.max(maxBack, this.chatScroll - 3);
      this.render();
      return;
    }
    if (key.startsWith('\x1b[<65;')) {
      this.chatScroll = Math.min(0, this.chatScroll + 3);
      this.render();
      return;
    }

    // Ctrl+L — clear and redraw
    if (key === '\x0c') {
      this.render();
      return;
    }

    // Ctrl+V — paste from clipboard (Windows)
    if (key === '\x16') {
      try {
        const { execSync } = require('child_process');
        let clipboard = '';
        if (process.platform === 'win32') {
          clipboard = execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8', timeout: 3000 }).trim();
        } else if (process.platform === 'darwin') {
          clipboard = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 }).trim();
        } else {
          clipboard = execSync('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null', { encoding: 'utf-8', timeout: 3000, shell: true }).trim();
        }
        if (clipboard) {
          // Replace newlines with spaces for input line
          const text = clipboard.replace(/[\r\n]+/g, ' ');
          this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
          this.inputCursor += text.length;
          this.commandPaletteOpen = this.inputBuffer.startsWith('/');
          this.render();
        }
      } catch {}
      return;
    }

    // Regular character or paste (multiple characters at once)
    if (key.length >= 1 && !key.startsWith('\x1b')) {
      // Accept all printable characters (including UTF-8 multi-byte)
      const text = key.replace(/[\x00-\x1f\x7f]/g, ''); // Strip control chars only
      if (text.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += text.length;

        // Open command palette when / is the first character
        if (this.inputBuffer.startsWith('/')) {
          this.commandPaletteOpen = true;
          this.commandPaletteSelection = 0;
        } else {
          this.commandPaletteOpen = false;
        }

        this.render();
      }
    }
  }

  _onResize() {
    this._computeLayout();
    this.render();
  }

  // ─── Public API ──────────────────────────────────────────────────────

  addChat(role, content) {
    this.showWelcome = false; // Dismiss welcome screen on first message
    const prefix = role === 'user'
      ? this.theme.accent + ' You: ' + ANSI.reset
      : role === 'assistant'
        ? this.theme.success + ' AI:  ' + ANSI.reset
        : this.theme.muted + '      ' + ANSI.reset;
    const contPrefix = '      '; // continuation indent
    const t = this.theme;

    const rawLines = content.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];

      // Code block toggle
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        const p = i === 0 ? prefix : contPrefix;
        if (inCodeBlock) {
          this.chatLines.push(p + t.border + '┌─ ' + t.muted + line.trim().slice(3) + ANSI.reset);
        } else {
          this.chatLines.push(contPrefix + t.border + '└─' + ANSI.reset);
        }
        continue;
      }

      const p = i === 0 ? prefix : contPrefix;
      const maxWidth = this.chatWidth - 7;

      if (inCodeBlock) {
        // Syntax highlight code lines
        const highlighted = this._highlightCode(line);
        this.chatLines.push(contPrefix + t.border + '│ ' + ANSI.reset + highlighted);
      } else {
        const wrapped = this._wordWrap(line, maxWidth);
        for (let j = 0; j < wrapped.length; j++) {
          this.chatLines.push((j === 0 ? p : contPrefix) + wrapped[j]);
        }
      }
    }
    this.chatLines.push(''); // spacer
    this.chatScroll = 0; // snap to bottom
    this.msgCount++;
    this.render();
  }

  addTool(name, status, detail) {
    const icon = status === 'ok' ? this.theme.success + '✓' :
                 status === 'err' ? this.theme.error + '✗' :
                 this.theme.accent + '⚙';
    const nameStr = name ? this.theme.accent + name + ANSI.reset + ' ' : '';
    const detailStr = detail ? this.theme.muted + detail + ANSI.reset : '';
    const line = ` ${icon} ${ANSI.reset}${nameStr}${detailStr}`;

    // Add to both chat and tool panel
    this.chatLines.push(line);
    this.toolLines.push(line);
    this.chatScroll = 0;
    this.render();
  }

  // Show a diff in the chat panel (non-blocking, inline)
  addDiff(filePath, oldStr, newStr, lineNum) {
    const t = this.theme;
    const maxLines = 8;

    this.chatLines.push(`${t.border}  ┌─ ${ANSI.reset}${t.accent}${filePath}:${lineNum}${ANSI.reset}`);

    const oldLines = oldStr.split('\n').slice(0, maxLines);
    const newLines = newStr.split('\n').slice(0, maxLines);

    for (const line of oldLines) {
      this.chatLines.push(`${t.border}  │ ${ANSI.reset}${t.error}- ${line}${ANSI.reset}`);
    }
    if (oldStr.split('\n').length > maxLines) {
      this.chatLines.push(`${t.border}  │ ${ANSI.reset}${t.muted}  ... (${oldStr.split('\n').length - maxLines} more)${ANSI.reset}`);
    }
    for (const line of newLines) {
      this.chatLines.push(`${t.border}  │ ${ANSI.reset}${t.success}+ ${line}${ANSI.reset}`);
    }
    if (newStr.split('\n').length > maxLines) {
      this.chatLines.push(`${t.border}  │ ${ANSI.reset}${t.muted}  ... (${newStr.split('\n').length - maxLines} more)${ANSI.reset}`);
    }

    this.chatLines.push(`${t.border}  └─${ANSI.reset}`);
    this.chatScroll = 0;
    this.render();
  }

  setStreaming(streaming) {
    this.isStreaming = streaming;
    this.render();
  }

  setModel(name) {
    this.model = name;
    this.render();
  }

  setTokenInfo(info) {
    this.tokenInfo = info || '';
    this.render();
  }

  // Stream a token into the last chat line
  streamToken(token) {
    if (this.chatLines.length === 0 || !this._lastLineIsStreaming) {
      this.chatLines.push(this.theme.success + ' AI:  ' + ANSI.reset);
      this._lastLineIsStreaming = true;
    }
    const lastIdx = this.chatLines.length - 1;
    const maxWidth = this.chatWidth - 7;

    // Handle newlines in token
    const parts = token.split('\n');
    this.chatLines[lastIdx] += parts[0];

    // Word wrap current line if too long
    if (this._stripAnsi(this.chatLines[lastIdx]).length > maxWidth) {
      const full = this.chatLines[lastIdx];
      const prefix = '      ';
      // Find where content starts (after any prefix)
      const stripped = this._stripAnsi(full);
      const wrapped = this._wordWrap(stripped, maxWidth);
      this.chatLines[lastIdx] = wrapped[0];
      for (let w = 1; w < wrapped.length; w++) {
        this.chatLines.push(prefix + wrapped[w]);
      }
    }

    for (let i = 1; i < parts.length; i++) {
      this.chatLines.push('      ' + parts[i]);
    }
    this.chatScroll = 0;
    this.render();
  }

  endStream() {
    this._lastLineIsStreaming = false;
    this.chatLines.push('');
    this.render();
  }

  // ─── Utilities ───────────────────────────────────────────────────────

  _truncate(str, maxLen) {
    const stripped = this._stripAnsi(str);
    if (stripped.length <= maxLen) return str;
    // Rough truncation (doesn't perfectly handle ANSI mid-cut)
    return str.slice(0, maxLen + (str.length - stripped.length)) + ANSI.reset;
  }

  _stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  _wordWrap(text, maxWidth) {
    if (maxWidth <= 0) maxWidth = 40;
    if (!text || this._stripAnsi(text).length <= maxWidth) return [text || ''];

    const words = text.split(' ');
    const lines = [];
    let current = '';

    for (const word of words) {
      const testLine = current ? current + ' ' + word : word;
      if (this._stripAnsi(testLine).length <= maxWidth) {
        current = testLine;
      } else {
        if (current) lines.push(current);
        // If a single word is longer than maxWidth, hard-break it
        if (this._stripAnsi(word).length > maxWidth) {
          let remaining = word;
          while (this._stripAnsi(remaining).length > maxWidth) {
            lines.push(remaining.slice(0, maxWidth));
            remaining = remaining.slice(maxWidth);
          }
          current = remaining;
        } else {
          current = word;
        }
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
  }

  _highlightCode(line) {
    const t = this.theme;
    let hl = line;
    // Strings
    hl = hl.replace(/(["'`])(?:(?!\1).)*\1/g, m => ANSI.fgRgb(140, 200, 120) + m + ANSI.reset);
    // Comments
    hl = hl.replace(/(\/\/.*)$/, m => t.muted + m + ANSI.reset);
    hl = hl.replace(/(#.*)$/, m => t.muted + m + ANSI.reset);
    // Keywords
    const kws = ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','new','this','true','false','null','undefined','pub','fn','struct','impl','mut','match','def','self','None','type','interface','enum'];
    for (const kw of kws) {
      hl = hl.replace(new RegExp(`\\b${kw}\\b`, 'g'), ANSI.fgRgb(180, 140, 220) + kw + ANSI.reset);
    }
    // Numbers
    hl = hl.replace(/\b(\d+)\b/g, ANSI.fgRgb(120, 200, 220) + '$1' + ANSI.reset);
    return hl;
  }
}

module.exports = { FullScreenTUI, ANSI, BOX, THEMES };
