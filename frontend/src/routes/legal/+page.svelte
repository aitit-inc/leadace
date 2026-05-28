<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import { EDITION } from '$lib/config';
  const lastUpdated = '2026-05-07';
</script>

<svelte:head>
  <title>特定商取引法に基づく表記 · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-6 py-12">
  <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
    <Logo size={14} class="text-accent" />
    ← LeadAce
  </a>
  <h1 class="mt-4 text-2xl font-semibold text-text">特定商取引法に基づく表記</h1>
  <p class="mt-1 text-xs text-text-muted">最終更新日: {lastUpdated}</p>

  {#if EDITION !== 'cloud'}
    <div class="mt-8 space-y-4 text-sm leading-relaxed text-text-secondary">
      <p>
        本ページは SurpassOne 株式会社が提供する LeadAce SaaS（<a
          href="https://leadace.ai"
          target="_blank"
          rel="noopener noreferrer"
          class="underline">leadace.ai</a
        >）に適用される特定商取引法表記です。現在ご覧の環境は LeadAce オープンソース版を別の運営者が
        セルフホストしているデプロイであり、本ページの SurpassOne 株式会社の情報は適用されません。
      </p>
      <p>
        本サイトの運営者へのお問い合わせや法定表記の確認は、当該運営者へ直接ご連絡ください。
      </p>
      <p>
        LeadAce オープンソース版:
        <a
          href="https://github.com/aitit-inc/leadace"
          target="_blank"
          rel="noopener noreferrer"
          class="underline">github.com/aitit-inc/leadace</a
        >
      </p>
    </div>
  {:else}
  <div class="mt-8 text-sm leading-relaxed text-text-secondary">
    <dl class="grid grid-cols-1 gap-y-4 sm:grid-cols-[12rem_1fr] sm:gap-x-6">
      <dt class="font-medium text-text">販売業者</dt>
      <dd>SurpassOne 株式会社</dd>

      <dt class="font-medium text-text">代表者</dt>
      <dd>宇野 礼於</dd>

      <dt class="font-medium text-text">所在地</dt>
      <dd>〒162-0052 東京都新宿区戸山 3-6-7</dd>

      <dt class="font-medium text-text">電話番号</dt>
      <dd>請求があり次第、遅滞なくお伝えいたします。お問い合わせは下記メールアドレスへお願いいたします。</dd>

      <dt class="font-medium text-text">メールアドレス</dt>
      <dd>
        <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>
      </dd>

      <dt class="font-medium text-text">販売価格</dt>
      <dd>
        各プランの月額または年額をお申し込み時の画面に表示します（米ドル建て、消費税は課税地の制度に従い別途課税されます）。
        <ul class="mt-2 list-disc pl-5 space-y-1">
          <li>Free: $0（永久無料、利用上限あり）</li>
          <li>Starter: $29 / 月、または $290 / 年（17% 割引）</li>
          <li>Pro: $79 / 月、または $790 / 年</li>
          <li>Scale: $199 / 月、または $1,990 / 年</li>
        </ul>
      </dd>

      <dt class="font-medium text-text">販売価格以外の必要料金</dt>
      <dd>
        本サービスのご利用に必要なインターネット接続料金、PC その他の機器、および Anthropic 社が提供する Claude Code の利用料金は、お客様のご負担となります。
      </dd>

      <dt class="font-medium text-text">支払方法</dt>
      <dd>クレジットカード（Stripe 決済）</dd>

      <dt class="font-medium text-text">支払時期</dt>
      <dd>
        月額プラン: 毎月のお申し込み日（または更新日）に課金されます。<br />
        年額プラン: 毎年のお申し込み日（または更新日）に課金されます。
      </dd>

      <dt class="font-medium text-text">サービスの提供時期</dt>
      <dd>
        決済完了後、即時にご利用いただけます。なお本サービスは現在パブリックベータ版として提供しており、
        機能変更・一時的な提供停止・不具合が発生する可能性があります。
      </dd>

      <dt class="font-medium text-text">返品・キャンセル</dt>
      <dd>
        本サービスはデジタルサービスの性質上、課金期間途中での返金には応じておりません。
        サブスクリプションのキャンセルは、ご契約者ご自身で
        <a href="https://app.leadace.ai/plans" class="underline">Plans 画面</a>
        の Manage subscription（Stripe Customer Portal）から行っていただけます。
        キャンセル後も、課金済みの期間が終了するまでは引き続きご利用いただけます。
      </dd>

      <dt class="font-medium text-text">送信先対応国</dt>
      <dd>
        本サービスから送信できる送り先（Email / 問い合わせフォーム / SNS DM）の所在国は、
        現時点で米国・カナダ・日本のみとなります。その他の国を所在国とする送り先への送信は、
        サービス側で送信時にブロックされます。詳細は
        <a href="https://app.leadace.ai/compliance" class="underline">Compliance</a>
        ページをご参照ください。
      </dd>

      <dt class="font-medium text-text">動作環境</dt>
      <dd>
        PC（macOS）+ Anthropic 社が提供する Claude Code 環境で動作確認済みです。
        最新版の主要 Web ブラウザもあわせてご利用ください。Windows / Linux やその他のランタイム
        （Claude Cowork、Codex 等）でも本プラグイン自体はインストール可能ですが、
        現時点では動作確認しておりません。
      </dd>
    </dl>
  </div>
  {/if}
</div>
