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
- [x] 同一sourceの局所検証時間とsemantic negativeを確認（18 sample、中央値0.956〜3.635秒、既知不具合2件を検出）
- [x] 実 CI で cold/warm の計測条件、Web 全件の網羅、Installed GUI・Offline media の検証結果を照合。同じ PR コミットの Web は291秒と298秒で、各回13,063件成功・監査済みスキップ110件。[PR の CI](https://github.com/kazuhide/bitovp/actions/runs/44126936633)
- [x] 2系統の独立レビューで指摘を解消。
- [x] [QC 実行制御 #152](https://github.com/kazuhide/bitovp/pull/152) と[検証ハーネス・CI #153](https://github.com/kazuhide/bitovp/pull/153) の必須 CI が成功し、main に統合。
- [x] マージ後のツリーと CI を照合し、Obsidian の統合記録に追記。[main の CI](https://github.com/kazuhide/bitovp/actions/runs/44129414735) は全ジョブ成功。Web は404秒で完了し、Webの4分割ジョブは合計1,249秒。集計ジョブの17秒を含む5ジョブ合計は1,266秒で、計画上限1,251秒を15秒超過した。
