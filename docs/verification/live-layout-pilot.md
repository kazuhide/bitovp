# Live 詳細のデザイン検証

Live 詳細の修正前後を、同じ日本語の合成チャンネルとユーザー操作で比較する試行です。実ブラウザーでラベル、クリック位置、折り返し、ページ幅を確かめます。配信やプレイヤーには接続しません。

| 方法 | 見るもの |
| --- | --- |
| 画像レビュー | 「新しい配信を始める」「ストリームキーをコピーする」などの目的を添え、対象箇所の画像から操作の見つけやすさを判定する。画像、操作目的、判定理由を一緒に保存する |
| Lean 4 | 配信中・終了済みと役割の組み合わせで表示すべき操作を定義する。履歴の開閉を任意回繰り返しても操作の集合が変わらないことをモデル上で証明する |
| Playwright | 合成データを使う実際の Live 詳細を開く。Lean の8条件から表示すべき操作を読み、クリック可否、重なり、横はみ出し、幅320pxでの入力値とコピー結果を確かめる |
| Bombadil | 実ページで履歴へのスクロール、履歴の開閉、ページ上部への復帰を試す。修正前の違反を保存し、新しいブラウザーで再生する |

1440pxのケースはボタン間隔が16 CSS px以内の同一行を期待します。320pxと390pxでは折り返しを許容し、ボタンが押せて画面内に収まることを確認します。ケースごとの期待値と由来は [live-layout-pilot-cases.json](../../tests/browser/live-layout-pilot-cases.json) にあります。画像レビューは再実行時も別途行い、操作目的を添え、どちらが修正後かを伏せて判定できます。

幅320pxでページが328pxまで広がり、RTMP・ストリームキーの値の幅が0pxになりました。入力ラベルの固定幅を狭い画面で小さくした結果、ページは320pxに収まり、値には78pxを確保できました。配信中の運用者と閲覧者でそれぞれ表示とコピー結果を確認しました。

## ローカルで再実行

Node、pnpm、リポジトリの依存関係と Playwright Chromium、Lean 4.24.0 を用意します。探索を行う場合は [Bombadil 0.7.10](https://github.com/antithesishq/bombadil/releases/tag/v0.7.10) の、既存runnerが対応する公式バイナリを使います。バイナリのSHA-256は実行時に照合されます。

修正前の `782632d355c6a8bf44b7c1ad02ba29f6bf853420` と検査対象のコミットを、別々の空のディレクトリへ detached worktree として取り出します。各 worktree で依存関係を入れ、使い捨て PostgreSQL の空のDBを用意します。

```sh
pnpm install --frozen-lockfile
pnpm --filter @bitovp/db build
DATABASE_URL="$pilot_db_url" pnpm --dir packages/db exec prisma migrate deploy
```

runner は作業ツリーのコミットと変更状態を照合し、空いているポートでそれぞれの Next 開発サーバーを自ら起動します。短い確認ファイルを各サーバーから読み戻して作業ツリーを照合します。試行用サーバーはアプリの `.env` や古い `.next` を取り込まず、試行終了時には起動したプロセスを止めます。同じ確認を再実行する場合は、作業用のコピーを改めて用意します。

runnerがある checkout で実行します。`--bombadil` を省略すると、Lean と確定的なブラウザーテスト、画像の保存を行います。

```sh
pnpm exec playwright install chromium
node --test tests/browser/live-layout-pilot-probe.test.mjs
BITOVP_PILOT_DATABASE_URL="$pilot_db_url" node scripts/live-layout-pilot.mjs \
  --historical=/absolute/path/to/before-worktree \
  --current=/absolute/path/to/current-worktree \
  --lean=/absolute/path/to/lean \
  --bombadil=/absolute/path/to/bombadil \
  --output=/absolute/path/to/new-evidence-directory
```

`observations.json` と画像は同じケースIDで確認できます。`design-review-cases.json` に画像と操作目的、`lean-oracle.json` に期待する操作、`explorations.json` に探索・再生結果を記録します。探索ではローカル専用Chromiumを使い、履歴の開閉と復帰を実際に確認できた場合に合格とします。旧版の再生は CLI の完了と同じ違反の両方を確認します。起動したテストサーバーと使い捨てDBは確認後に終了します。

この試行の範囲は Live 詳細の確定した配信状態と合成データです。画像判断の対象は提示した範囲で、ページ下部を含む横はみ出しは実寸で確認します。Lean の証明はモデルに適用され、アプリとの一致はブラウザーで検査します。手動で実行できる試行として扱い、現行の CI を利用します。
