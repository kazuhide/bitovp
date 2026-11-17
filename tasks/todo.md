# ハーネス改善の実装・検証

- [x] 講演全文と公開コードの調査
- [x] Astroによる2系統の設計レビューと現mainへの照合
- [x] 設計・合否条件・保証限界を定義
- [x] A: 固定feature registry / doctor / bounded run / receiptを実装
- [x] A: 負例・中断・CLI実行・CI接続を検証
- [x] B: LOCAL QCの中止と期限を実装
- [x] B: 中止競合・期限・partial result・gate復帰を検証
- [x] B: 2系統レビューと必須CI15項目を通し、PR152をmainへmerge
- [x] CIの実測とAstro設計レビュー、Web全件分割・HDR build再利用を実装
- [ ] 同一sourceの局所検証時間とsemantic negativeを確認
- [ ] 実CIのcold/warm時間・全件coverage・全proofを照合
- [ ] 2系統の独立レビューのRequired/Criticalを解消
- [ ] 両PRの必須CIを通しmainへmerge
- [ ] 最終mainの内容・checksを照合しObsidianの設計に結果を追記
