import type { InquiryLocale, InquiryPrimaryReason } from '$lib/api/inquiry';

// Recipient-facing copy for the inquiry landing page, localized by the
// visitor's browser language ($lib/browser-locale). Scoped to this feature on
// purpose — this is NOT app-wide i18n; the operator UI stays English.
export type InquiryCopy = {
  greetingName: (name: string) => string;
  greetingOrg: (org: string) => string;
  greetingPreviewPlaceholder: string;
  greetingFallback: string;
  from: string;
  at: string;
  thanksTitle: string;
  schedulingIntro: (displayName: string) => string;
  openSchedulingPage: string;
  schedulingPopupHint: (displayName: string) => string;
  notifyOnlyIntro: (displayName: string) => string;
  notifyOnlySpeedUp: string;
  signupTitle: string;
  signupIntro: (displayName: string) => string;
  openSignupPage: string;
  signupPopupHint: string;
  unsubTitle: string;
  unsubBody: string;
  unsubThanks: (displayName: string) => string;
  unsubReasonPrompt: (displayName: string) => string;
  chip: Record<InquiryPrimaryReason, string>;
  watchVideo: string;
  ctaSignup: string;
  ctaOpening: string;
  ctaBookMeeting: string;
  ctaRequestMeeting: string;
  ctaSending: string;
  downloadPdf: string;
  chatHeading: string;
  chatPlaceholderFirst: string;
  chatPlaceholderReply: string;
  chatLimitPre: string;
  chatLimitBtn: string;
  chatLimitPost: string;
  send: string;
  sendAria: string;
  generatingResponse: string;
  videoTitle: string;
  unsubscribeCta: string;
  unsubscribing: string;
  privacy: string;
};

const EN: InquiryCopy = {
  greetingName: (name) => `Hi ${name},`,
  greetingOrg: (org) => `Hi ${org} team,`,
  greetingPreviewPlaceholder: 'Hi {Recipient},',
  greetingFallback: 'Hi there,',
  from: 'From',
  at: 'at',
  thanksTitle: "Thanks — we'll be in touch.",
  schedulingIntro: (dn) =>
    `We opened ${dn}'s scheduling page in a new tab. Pick a time there to lock in your slot — once booked, you'll get a confirmation email with the calendar invite directly from the scheduling tool.`,
  openSchedulingPage: 'Open scheduling page ↗',
  schedulingPopupHint: (dn) =>
    `If the scheduling tab didn't open (popup blocker, etc.), just tap the link above — your interest is already recorded so ${dn} will follow up even without a booking.`,
  notifyOnlyIntro: (dn) =>
    `${dn} has been notified that you'd like to talk and will reach out directly — typically within 1–2 business days.`,
  notifyOnlySpeedUp:
    "If you'd like to speed things up, replying on the original thread with a few times that work for you is the fastest path.",
  signupTitle: "You're all set — finish in the new tab.",
  signupIntro: (dn) =>
    `We opened the signup page in a new tab. Complete your account there to start using ${dn}'s product right away — no scheduling or sales call needed.`,
  openSignupPage: 'Open signup page ↗',
  signupPopupHint: "If the tab didn't open (popup blocker, etc.), just tap the link above.",
  unsubTitle: "You've been unsubscribed.",
  unsubBody: "We won't send you any more outreach.",
  unsubThanks: (dn) => `Thanks for the feedback — it helps ${dn} target better.`,
  unsubReasonPrompt: (dn) => `Optional — pick the closest reason so ${dn} can do better next time.`,
  chip: {
    not_relevant: 'Not relevant',
    wrong_timing: 'Wrong timing',
    already_have_solution: 'Already have it',
    budget: 'Too expensive',
    feature_gap: 'Missing feature',
    other: 'Other',
  },
  watchVideo: 'Watch the intro video',
  ctaSignup: 'Sign up',
  ctaOpening: 'Opening…',
  ctaBookMeeting: 'Book a meeting',
  ctaRequestMeeting: 'Request a meeting',
  ctaSending: 'Sending…',
  downloadPdf: 'Download the PDF',
  chatHeading: 'Ask a question',
  chatPlaceholderFirst: 'e.g. Pricing? Does it support X?',
  chatPlaceholderReply: 'Type your reply',
  chatLimitPre: "That's the chat limit. Use ",
  chatLimitBtn: 'Request a meeting',
  chatLimitPost: ' above to talk to a person.',
  send: 'Send',
  sendAria: 'Send',
  generatingResponse: 'Generating response',
  videoTitle: 'Intro',
  unsubscribeCta: "Don't want these messages? Unsubscribe",
  unsubscribing: 'Unsubscribing…',
  privacy: 'Privacy',
};

const JA: InquiryCopy = {
  greetingName: (name) => `${name} 様`,
  greetingOrg: (org) => `${org} ご担当者様`,
  greetingPreviewPlaceholder: '{Recipient} 様',
  greetingFallback: 'ご担当者様',
  from: '差出人',
  at: '／',
  thanksTitle: 'ありがとうございます。担当者よりご連絡いたします。',
  schedulingIntro: (dn) =>
    `${dn} の予約ページを新しいタブで開きました。そちらでご都合の良い時間をお選びいただくと予約が確定し、予約ツールから日程の招待を含む確認メールが届きます。`,
  openSchedulingPage: '予約ページを開く ↗',
  schedulingPopupHint: (dn) =>
    `予約タブが開かなかった場合（ポップアップブロックなど）は、上のリンクをタップしてください。ご関心はすでに記録されていますので、予約がなくても ${dn} よりフォローアップいたします。`,
  notifyOnlyIntro: (dn) =>
    `${dn} にご連絡のご希望をお伝えしました。通常1〜2営業日以内に直接ご連絡いたします。`,
  notifyOnlySpeedUp:
    'お急ぎの場合は、元のメールスレッドにご都合の良い日時をいくつか返信いただくのが最も早い方法です。',
  signupTitle: '準備が整いました。新しいタブで完了してください。',
  signupIntro: (dn) =>
    `登録ページを新しいタブで開きました。そちらでアカウントを作成いただければ、すぐに ${dn} の製品をご利用いただけます。打ち合わせや営業電話は不要です。`,
  openSignupPage: '登録ページを開く ↗',
  signupPopupHint: 'タブが開かなかった場合（ポップアップブロックなど）は、上のリンクをタップしてください。',
  unsubTitle: '配信を停止しました。',
  unsubBody: '今後、ご連絡をお送りすることはありません。',
  unsubThanks: (dn) => `フィードバックをありがとうございます。${dn} がより的確にお届けするのに役立ちます。`,
  unsubReasonPrompt: (dn) =>
    `任意 — 最も近い理由をお選びいただくと、${dn} が次回の改善に役立てられます。`,
  chip: {
    not_relevant: '関係がない',
    wrong_timing: 'タイミングが合わない',
    already_have_solution: 'すでに導入済み',
    budget: '予算が合わない',
    feature_gap: '機能が足りない',
    other: 'その他',
  },
  watchVideo: '紹介動画を見る',
  ctaSignup: '登録する',
  ctaOpening: '開いています…',
  ctaBookMeeting: '打ち合わせを予約',
  ctaRequestMeeting: '打ち合わせを依頼',
  ctaSending: '送信中…',
  downloadPdf: 'PDF をダウンロード',
  chatHeading: '質問する',
  chatPlaceholderFirst: '例: 料金は？ ◯◯に対応していますか？',
  chatPlaceholderReply: '返信を入力',
  chatLimitPre: 'チャットの上限に達しました。担当者と話すには、上の',
  chatLimitBtn: '打ち合わせを依頼',
  chatLimitPost: 'をご利用ください。',
  send: '送信',
  sendAria: '送信',
  generatingResponse: '応答を生成しています',
  videoTitle: '紹介',
  unsubscribeCta: '配信を停止する',
  unsubscribing: '停止しています…',
  privacy: 'プライバシー',
};

export function inquiryCopy(locale: InquiryLocale): InquiryCopy {
  return locale === 'ja' ? JA : EN;
}
