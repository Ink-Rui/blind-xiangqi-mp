interface OptItem { v: string; name: string; desc: string }
interface SelCfg { shuffle: string; rule: string; play: string; level: string }

const OPTS: { shuffle: OptItem[]; rule: OptItem[]; play: OptItem[]; level: OptItem[] } = {
  shuffle: [
    { v: 'A1', name: 'A1 半盘内洗', desc: '将帅明置九宫原位，各 15 子在本方半盘内洗；归属可由位置推知' },
    { v: 'A2', name: 'A2 跨河全混', desc: '将帅明置，其余 30 子跨河混置；归属未知' },
    { v: 'B', name: 'B 全盘混洗', desc: '32 子含将帅全部暗置混洗；归属完全未知，最刺激' }
  ],
  rule: [
    { v: 'check', name: '将军规则', desc: '将军/应将/将死；仅对已翻开的将帅生效，暗将可被直接吃' },
    { v: 'kill', name: '吃将即胜', desc: '吃掉对方将/帅立即获胜，无将军应将流程' }
  ],
  play: [
    { v: 'hot', name: '双人同屏', desc: '面对面轮流操作一部手机，信息双方公开' },
    { v: 'ai', name: '随机陪练', desc: '单人对弈：与 AI 陪练过招，可选下方三档难度' }
  ],
  level: [
    { v: 'easy', name: '简单', desc: 'AI 随手乱走，适合熟悉规则' },
    { v: 'normal', name: '普通', desc: 'AI 倾向吃子，但时常漏算' },
    { v: 'hard', name: '困难', desc: 'AI 权衡吃子与风险，护将推进、不白送子' }
  ]
};

const SHUFFLES = ['A1', 'A2', 'B'];
const RULES = ['check', 'kill'];
const PLAYS = ['hot', 'ai'];
const LEVELS = ['easy', 'normal', 'hard'];

Page({
  data: {
    opts: OPTS,
    sel: { shuffle: 'A1', rule: 'check', play: 'hot', level: 'normal' } as SelCfg
  },

  onLoad() {
    // 恢复上次选择（逐项校验，旧版本存储缺 level 时不影响其余项）
    try {
      const c = wx.getStorageSync('cfg');
      if (c) {
        const sel = { ...this.data.sel } as Record<string, string>;
        if (SHUFFLES.indexOf(c.shuffle) >= 0) sel.shuffle = c.shuffle;
        if (RULES.indexOf(c.rule) >= 0) sel.rule = c.rule;
        if (PLAYS.indexOf(c.play) >= 0) sel.play = c.play;
        if (LEVELS.indexOf(c.level) >= 0) sel.level = c.level;
        this.setData({ sel: sel as unknown as SelCfg });
      }
    } catch (e) { /* 存储不可用时忽略 */ }
  },

  onPick(e: any) {
    const group = String(e.currentTarget.dataset.group);
    const v = String(e.currentTarget.dataset.v);
    this.setData({ ['sel.' + group]: v } as Record<string, unknown>);
  },

  onStart() {
    const sel = this.data.sel;
    try { wx.setStorageSync('cfg', sel); } catch (e) { /* 忽略 */ }
    wx.navigateTo({
      url: '/pages/game/game?shuffle=' + sel.shuffle + '&rule=' + sel.rule + '&play=' + sel.play + '&level=' + sel.level
    });
  }
});
