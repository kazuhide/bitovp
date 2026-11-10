"use client";
import { useT } from "@/lib/i18n/context";

const en = {
	projectMayContinue:
		"Editing proposal creation may still be running. Checking this request can start it if it was not accepted.",
	projectWaitStopped:
		"Waiting for project creation has stopped. Source preparation may continue.",
	projectPreparationUnknown:
		"Source preparation may have been accepted. Automatic project creation has stopped. Refresh the source list and explicitly select the prepared source.",
	stopProjectWait: "Stop waiting for project creation",
	continueProjectCreation: "Continue with these settings",
	retrySameProject: "Check the same project request",
	projectCreate: "Create project",
	projectSettings: "Caption, framing and scene settings",
	projectDraftOnly:
		"The project opens on an editable timeline. An MP4 is generated only when you choose Generate in the editor.",
	encoding: "Encoding ID",
	manualSourceTools: "Source tools and manual editing",
	manualSourceHelp:
		"This source has no linked encoding. Open source tools to prepare material or start a manual project.",
	contextLoaded:
		"Loaded the video output and AISA metadata from this encoding.",
	contextPreparing:
		"The editing source is being prepared. Refresh to check its progress.",
	contextAnalysisPending:
		"AISA metadata is not ready for this encoding. Refresh after its analysis finishes.",
	contextNeedsPreparation:
		"Creating the project will also prepare this encoding's video for editing.",
	contextNeedsConfirmation:
		"Review the video and AISA association below before creating the project.",
	contextUnavailable:
		"Editing inputs for this encoding could not be resolved. Refresh or check the encoding's video output and AISA metadata.",
	projectCreateHelp:
		"Create an editing proposal with scenes, framing and captions. Review it on the timeline before generating an MP4.",
	projectProgress: "Project preparation",
	projectFailed: "Project preparation failed",
	projectCanceled: "Project preparation canceled",
	cancelProject: "Cancel project preparation",
	savingProject: "Saving the editing proposal",
	projectReady: "Your editing proposal is ready. Review it in the editor.",
	openEditor: "Open editor",
	reviewReasonTitle: "Why this needs review",
	speechReviewSummary:
		"Review clip beginnings, endings and captions before generating the MP4.",
	speechDurationReviewReason:
		"Avoiding the detected speech would shorten the original scene selection substantially. The original proposal is shown to stay closer to the requested length.",
	speechReviewReason:
		"The detected speech could not be kept within safe whole-shot boundaries.",
	speechSearchLimitReviewReason:
		"The additional speech-boundary search reached its limit, so the initial selection is being used.",
	speechDurationReviewRequired:
		"Avoiding the detected speech would shorten the original scene selection substantially. The original proposal is shown to stay closer to the requested length. Review clip beginnings, endings and captions before generating the MP4.",
	speechReviewRequired:
		"The detected speech could not be kept within safe whole-shot boundaries. Review the clip beginnings, endings and captions before generating the MP4.",
	generationMayContinue:
		"Generation may still be running. Retrying this request can start it if it was not accepted.",
	refining: "Checking speech boundaries",
	speechFallback:
		"Speech boundaries could not be verified. Scenes were selected using metadata. Review the start and end.",
	speechContextLimit:
		"Speech analysis covered up to 180 seconds around the selected scenes. Audio beyond that range was not evaluated.",
	speechSelectionChanged:
		"Speech-aware selection was updated. Retry as a new task to use the current policy.",
	noSpeechSafeWindow:
		"No whole-shot window in the observed audio avoids cutting the detected speech. Increase the desired length or review the selection settings.",
	preparedClockUnavailable:
		"The frame correspondence for this prepared source could not be verified. Prepare a new version from the original file and confirm its analysis association.",

	prepareGenerateTitle: "Prepare a source and generate",
	prepareGenerateHelp:
		"Choose an original file and destination. These settings are fixed when you start.",
	prepareGenerateAction: "Prepare and generate",
	preparingMaterial: "Preparing the selected source…",
	checkingPreparedAssociation: "Checking the prepared source and analysis…",
	cancelGenerationReservation: "Cancel this generation request",
	preparationContinues:
		"The generation request was canceled. Source preparation may continue.",
	preparationOutcomeUnknown:
		"Preparation may have been accepted. Automatic generation has stopped. Refresh the source list and explicitly select the prepared source.",
	selectPreparedExplicitly: "Return to the prepared source list",
	continueReservedGeneration: "Continue with these settings",
	retrySameGeneration: "Check the same generation request",
	preparationReadStopped:
		"Source preparation could not be confirmed. Refresh the source list before continuing.",

	advanced: "Advanced generation settings",
	close: "Close advanced settings",
	configuredTitle: "Configure generation",
	configuredHelp:
		"Use the selected source, analysis and desired length above. The generated projects remain editable.",
	policy: "Selection policy",
	automaticSelection: "Automatic highlights",
	localStorySelection: "Story-led edit",
	policyLocalStoryHelp:
		"Build a short edit from the relationships between subjects and events in AISA and speech.",
	policyLocalStoryDetails:
		"Identify subjects, events and their evidence, then choose a connected structure within the requested length. Source order is preserved. Missing context remains uncertain rather than being invented.",
	storyMode: "Editing approach",
	storyModeHelp:
		"Automatic chooses an approach for this source and length. Both approaches condense the content and keep the result editable.",
	storyAuto: "Choose automatically",
	storyFlow: "Follow the story",
	storyTheme: "Build around a theme",
	policyAutoHelp:
		"Automatic highlights ranks AISA scene descriptions, key elements and changes without a context query.",
	policyAutoDetails:
		"Use the characters, objects and event descriptions already in AISA to rank whole-shot windows. This metadata-based ranking is a starting proposal. When useful cues are absent, prefer scene continuity.",
	policyHelp:
		"Scene continuity favors related shots. Closest whole-shot duration favors the requested length.",
	policyDetails: "Selection policy details",
	policyCohesionDetails:
		"Prefer consecutive shots within one scene when its best duration is at least 80% of the longest eligible window. Otherwise, use that longer window across scenes. Each context word filters AISA descriptions and keywords.",
	policyDurationDetails:
		"Choose the longest adjacent shot window within the requested length. Break ties by fewer scene changes, then an earlier start. Context filtering is not used.",
	policySharedTitle: "Shared rules",
	policySharedDetails:
		"Keep source order and shot boundaries, or scene intervals when shots are absent. Excluding ads or credits and limiting the clip count can shorten the result.",
	policySpeechDetails:
		"Automatic captions may refine the selection using observed speech boundaries. Review any notes in the editing proposal.",
	cohesion: "Scene continuity",
	duration: "Closest whole-shot duration",
	query: "Context to include",
	queryHelp:
		"Describe the topic or scene. Selection uses the recorded scene descriptions.",
	videoFit: "Video framing",
	videoPreserveAuto: "Full image + blurred background",
	videoPreserveFill: "Crop to fill",
	videoPreserveContain: "Full image + black bars",
	videoPreserveHelp: "Automatic framing keeps the full source image.",
	videoPreserveBackgroundHelp:
		"Unused space uses a blurred background. Choose cropping explicitly to use saved framing.",
	videoPreserveDetails:
		"Saved framing and measured tracks remain available for cropping. This applies to the main video; picture in picture and custom layouts stay in place.",
	videoPreserveSummary:
		"Blurred backgrounds and black bars keep the full source. Fill crops the image.",
	videoAuto: "Auto adjust",
	videoAutoHelp: "Use saved framing and measured subject tracks.",
	videoAutoFallbackHelp:
		"Show the full image with a blurred background where neither is available.",
	videoAutoDetails:
		"This applies to the main video. Picture in picture and custom layouts keep their placement.",
	videoAutoBandsHelp:
		"The blurred background stays within the main video area. Caption bands stay unchanged.",
	videoFill: "Fill the canvas",
	videoContain: "Show the full image (with space)",
	presentationDetails: "Video and caption layout details",
	videoFitSummary:
		"Fill crops the image; Full image keeps the whole source with space.",
	captionPlacementSummary: "Place captions on the image or in reserved bands.",
	videoStaticHelp:
		"Fill keeps tracked framing and uses fixed framing only in untracked ranges. Full image keeps the whole source.",
	videoStaticReferenceHelp:
		"AISA positions are references for fixed candidates. Compare and choose a candidate for each scene in Fill mode.",
	videoFitHelp:
		"Fill uses the measured framing, or a central crop where tracking is unavailable. Check that the subject stays visible. Full image preserves the source and can leave space.",
	captionPlacement: "Caption placement",
	captionOverlay: "Overlay on the video",
	captionBands: "Use top and bottom bands",
	captionPlacementHelp:
		"Overlay uses a caption background on the video. Bands reserve space for captions; the space remains even if captions are removed. You can change the background in the editor.",
	trackingPreserveHelp:
		"Measured motion is saved for later cropping. Full-image display keeps the whole source.",
	trackingStaticHelp:
		"Measure the subject motion in real frames. Use fixed framing candidates where tracking is unavailable.",
	trackingFillHelp:
		"Measure frames within each shot to follow the subject. When tracking is unavailable, Fill shows a central crop that you should review.",
	template: "First format",
	portrait: "Portrait · 9:16",
	landscape: "Landscape · 16:9",
	square: "Square · 1:1",
	variants: "Formats to generate",
	variantsHelp:
		"Additional formats use the other canvas shapes, with the same selected shots.",
	captions: "Automatic captions",
	captionMode: "Captions",
	captionsOff: "None",
	captionsOriginal: "Original language",
	captionsJapanese: "Japanese translation",
	captionTranslationHelp:
		"Only recognized speech becomes captions. Translation keeps the original cue timing.",
	captionTranslationUnavailable:
		"Japanese translation is available when the local model is connected.",
	captionsHelp:
		"Recognize local audio. Word highlighting appears only when measured word timings are available.",
	tracking: "Follow the visible subject",
	trackingHelp:
		"Measure sampled frames within each shot. Use FIT when the subject cannot be followed reliably.",
	language: "Speech language",
	auto: "Detect automatically",
	japanese: "Japanese",
	english: "English",
	start: "Start configured generation",
	starting: "Starting…",
	unknown: "The request result is unknown. Retry keeps the same request key.",
	error: "The operation could not be completed. Refresh or try again.",
	dependencyUnavailable:
		"The saved transcript or tracking does not match this source, analysis or selected range. Start a new generation with matching inputs.",
	readOnly: "Read-only access. An operator can start or change generation.",
	associationTitle: "Analysis and source association",
	loadingAssociation: "Checking the source association…",
	verified: "Recorded source association",
	captured: "Captured input identity was verified.",
	fixture: "Fixture-authored metadata. This is not a real AISA capture.",
	attested: "An operator confirmed the time, geometry and content association.",
	unverified:
		"This analysis has no verified association with the prepared source. Review the video and scene descriptions before confirming.",
	video: "Prepared source for association review",
	videoError:
		"The source video could not be played. Reload it before confirming.",
	time: "I checked that the scene times match this video.",
	geometry: "I checked the resolution, orientation and subject coordinates.",
	content: "I checked that the scene descriptions match the video content.",
	confirm: "Record this association",
	confirming: "Recording…",
	associationHelp:
		"This records your human review. It does not claim a captured provider input identity.",
	scenes: "Scene descriptions",
	noScenes: "No scene descriptions are available.",
	reload: "Refresh",
	resolution: "Prepared resolution",
	originalStart: "Original source start",
	moreScenes:
		"Only the first 20 scenes are shown. Review the source analysis for the remaining scenes.",
	progressTitle: "Generation progress",
	loading: "Loading generation…",
	queued: "Queued",
	preparing: "Waiting for media preparation",
	waitingCache: "Waiting for the same generation",
	downloading: "Reading prepared source",
	selecting: "Selecting whole shots",
	analyzingStory: "Reading the available AISA story descriptions",
	selectingStory: "Selecting a connected passage",
	transcribingStory: "Transcribing speech for the editing structure",
	transcribingSections: "Speech recognition {completed} / {total} sections",
	analyzingLocalStory: "Organizing subjects and events",
	analyzingSections: "Content analysis {completed} / {total} sections",
	planningLocalStory: "Building the short edit",
	localStoryUnavailable:
		"Automatic editing is temporarily unavailable. Try again shortly.",
	localStoryChanged:
		"The editing configuration has changed. Create a new editing proposal.",
	localStoryContextLimit:
		"This source could not be processed within the analysis limits. Ask the operator to check the analysis settings.",
	localStoryPlanUnavailable:
		"A connected edit could not fit the requested length. Try another length or editing approach.",
	localStoryCoherence:
		"The selected scenes do not yet form a supported sequence. Try another length or scene settings.",
	localStoryDurationLimited:
		"This proposal is shorter to keep the supported events together.",
	localStoryUnverified:
		"The analysis evidence could not be verified. Retry as a new editing proposal.",
	localStoryCancelUnconfirmed:
		"The operation's stop could not be confirmed. Refresh its status before starting another request.",
	storyEngineUnavailable:
		"Story selection is unavailable. Refresh after the analysis model has been configured.",
	storyGraphInvalid:
		"The story analysis could not be verified. Retry as a new task.",
	storyModelChanged:
		"The story analysis model has changed. Retry as a new task to use the current model.",
	transcribing: "Recognizing speech",
	aligningCaptions: "Matching captions to speech",
	trackingPhase: "Following the subject",
	publishing: "Saving projects and queuing exports",
	running: "Processing",
	complete: "Projects created",
	failed: "Generation failed",
	canceled: "Generation canceled",
	cached: "Reused an exact saved result",
	resultHelp:
		"The editable projects are ready. Open a result to follow its MP4 export and play or download it when rendering finishes.",
	cancel: "Cancel generation",
	canceling: "Requesting cancellation…",
	cancelRequested: "Cancellation requested. Waiting for the worker to stop.",
	retry: "Retry as a new task",
	retrying: "Starting retry…",
	warningTitle: "Generation notes",
	durationLabel: "Actual / requested length",
	result: "Open result",
	invalidResult:
		"The saved generation result could not be verified. Refresh this page.",
	warningFallback:
		"Some processing used a fallback. Review the generated project.",
	noAudio: "The source has no audio, so no captions were added.",
	noSpeech: "No speech was detected in the selected audio.",
	noModel: "Speech recognition is not configured. No captions were added.",
	segmentOnly:
		"Some captions were omitted because their speech timing could not be established.",
	clamped: "A caption segment was limited to the measured audio end.",
	fit: "Some ranges could not be tracked. Review their framing in the editor.",
	noShot: "No eligible shot evidence was available for tracking.",
	trackerChanged:
		"Tracking was updated. Retry as a new task to use the current tracker.",
	asrFailed:
		"Speech recognition could not provide a verified transcript. No guessed captions were added.",
};
const ja: Record<keyof typeof en, string> = {
	projectMayContinue:
		"編集案の作成が続いている可能性があります。同じ要求を確認すると、未受付の場合は編集案の作成を開始します。",
	projectWaitStopped:
		"編集案の作成の待機をやめました。素材の準備は継続する場合があります。",
	projectPreparationUnknown:
		"素材の準備を受け付けた可能性があります。編集案の自動作成は止めています。一覧を更新し、準備済み素材を明示して選んでください。",
	stopProjectWait: "作成の待機をやめる",
	continueProjectCreation: "編集案の作成を続ける",
	retrySameProject: "同じ作成要求の結果を確認",
	projectCreate: "プロジェクトを作成",
	projectSettings: "字幕・構図・場面の設定",
	projectDraftOnly:
		"作成したプロジェクトは編集済みタイムラインで開きます。MP4は編集画面で「生成」を押した時に書き出します。",
	encoding: "エンコーディングID",
	manualSourceTools: "素材の操作・手動編集",
	manualSourceHelp:
		"この素材にはエンコーディングの関連付けがありません。「素材の操作・手動編集」から素材の準備や手動プロジェクトの作成を進められます。",
	contextLoaded:
		"このエンコーディングの出力映像とAISAメタデータを読み込みました。",
	contextPreparing:
		"編集用の素材を準備しています。更新して準備状況を確認してください。",
	contextAnalysisPending:
		"このエンコーディングのAISAメタデータは未準備です。解析の完了後に更新してください。",
	contextNeedsPreparation:
		"プロジェクトの作成とあわせて、このエンコーディングの映像を編集用に準備します。",
	contextNeedsConfirmation:
		"プロジェクトを作成する前に、下の映像とAISAメタデータの対応を確認してください。",
	contextUnavailable:
		"このエンコーディングの編集素材を特定できません。更新するか、出力映像とAISAメタデータの状態を確認してください。",
	projectCreateHelp: "場面・構図・字幕をまとめた編集案を作成します。",
	projectProgress: "編集案の準備",
	projectFailed: "編集案を作成できませんでした",
	projectCanceled: "編集案の作成をキャンセルしました",
	cancelProject: "編集案の作成をキャンセル",
	savingProject: "編集案を保存しています",
	projectReady: "編集案を作成しました。編集画面で内容を確認してください。",
	openEditor: "編集画面を開く",
	reviewReasonTitle: "確認が必要な理由",
	speechReviewSummary:
		"生成前に、各区間の始まり・終わりと字幕を確認してください。",
	speechDurationReviewReason:
		"発話の途中を避けると元の案から大きく短くなるため、希望尺に近い元の案を表示しています。",
	speechReviewReason:
		"観測した発話の途中を避けるショット区間を選べませんでした。",
	speechSearchLimitReviewReason:
		"字幕境界の追加探索が上限に達したため、最初の選定案を使っています。",
	speechDurationReviewRequired:
		"発話の途中を避けると元の案から大きく短くなるため、希望尺に近い元の案を表示しています。MP4を生成する前に、各区間の始まり・終わりと字幕を確認してください。",
	speechReviewRequired:
		"観測した発話の途中を避けるショット区間を選べませんでした。MP4を生成する前に、各区間の始まり・終わりと字幕を確認してください。",
	generationMayContinue:
		"生成が続いている可能性があります。この要求を再試行すると、未受付の場合は生成を開始します。",
	refining: "発話の切れ目を確認しています",
	speechFallback:
		"発話の切れ目を確認できず、場面情報を使って選びました。始まりと終わりを確認してください。",
	speechContextLimit:
		"音声の解析は最大180秒の周辺区間に限定しています。範囲外の発話は判定していません。",
	speechSelectionChanged:
		"発話を使う選定処理が更新されました。新しいタスクとして再試行してください。",
	noSpeechSafeWindow:
		"観測した音声の範囲で、発話の途中を避けるショットのまとまりを選べませんでした。希望尺を増やすか、選択条件を見直してください。",
	preparedClockUnavailable:
		"準備済み映像のフレーム対応を確認できません。元ファイルから新しい映像版を準備し、解析との対応を確認してください。",

	prepareGenerateTitle: "元ファイルから準備して生成",
	prepareGenerateHelp:
		"元ファイルと出力先を選びます。開始時の生成設定を固定して処理を進めます。",
	prepareGenerateAction: "準備して生成",
	preparingMaterial: "選択した素材を準備しています…",
	checkingPreparedAssociation: "準備済み素材と解析の対応を確認しています…",
	cancelGenerationReservation: "この生成予約を取り消す",
	preparationContinues:
		"生成予約を取り消しました。素材の準備は継続する場合があります。",
	preparationOutcomeUnknown:
		"素材の準備を受け付けた可能性があります。自動生成は止めています。一覧を更新し、準備済み素材を明示して選んでください。",
	selectPreparedExplicitly: "準備済み素材の一覧に戻る",
	continueReservedGeneration: "この設定で生成を続ける",
	retrySameGeneration: "同じ生成要求の結果を確認",
	preparationReadStopped:
		"素材の準備状況を確認できませんでした。一覧を更新してから続けてください。",

	advanced: "追加の生成設定",
	close: "追加設定を閉じる",
	configuredTitle: "生成内容の設定",
	configuredHelp:
		"上で選んだ素材・解析・希望尺を使います。生成したプロジェクトは後から編集できます。",
	policy: "選択方法",
	automaticSelection: "見どころを自動選定",
	localStorySelection: "話のつながりから編集",
	policyLocalStoryHelp:
		"AISAと発話から、対象の役割や出来事の関係を読み取り、短い編集案を作ります。",
	policyLocalStoryDetails:
		"登場する対象・出来事と根拠を整理し、希望尺へ収まる話の骨格を選びます。元映像の提示順を保ち、足りない文脈や不明な関係を創作しません。",
	storyMode: "編集方針",
	storyModeHelp:
		"おまかせでは素材と尺に合う方針を選びます。どちらも内容を凝縮し、後から編集できます。",
	storyAuto: "おまかせ",
	storyFlow: "流れをつなぐ",
	storyTheme: "テーマでまとめる",
	policyAutoHelp:
		"「見どころを自動選定」はAISAの場面説明や登場要素、変化の記述をもとに選びます。内容の入力は不要です。",
	policyAutoDetails:
		"AISAに記録されたキャラクター・物体・出来事の記述から、ショットのまとまりに優先順位を付けます。記述に基づく初期案として作成し、手がかりが少ない場合はシーンのつながりを優先します。",
	policyHelp:
		"「シーンのつながりを優先」は場面のまとまり、「ショット単位で希望尺に近づける」は長さを優先します。",
	policyDetails: "選択方法の詳しい説明",
	policyCohesionDetails:
		"同じシーンの連続ショットで、最長案の80%以上の長さを確保できる場合は、その案を選びます。足りない場合は、シーンをまたぐ案を使います。「含めたい内容」に入力した各語で、AISAの説明やキーワードなどを絞り込みます。",
	policyDurationDetails:
		"隣接するショットから、希望尺を超えない最長区間を選びます。同じ長さなら、シーンの切り替えが少なく、開始が早い案を優先します。「含めたい内容」による絞り込みは使いません。",
	policySharedTitle: "共通の条件",
	policySharedDetails:
		"元映像の順序とショットの区切りを保ちます。ショット情報がない場合は、シーンの区間を使います。広告・クレジットなどの除外やカット数の上限で、希望尺より短くなる場合があります。",
	policySpeechDetails:
		"自動字幕を使う場合は、観測した発話の切れ目によって案が変わることがあります。作成した編集案に表示される注意も確認してください。",
	cohesion: "シーンのつながりを優先",
	duration: "ショット単位で希望尺に近づける",
	query: "含めたい内容",
	queryHelp: "話題や場面を入力します。記録済みのシーン説明をもとに選択します。",
	videoFit: "映像の収め方",
	videoPreserveAuto: "全体表示＋ぼかし背景",
	videoPreserveFill: "切り抜いて画面いっぱい",
	videoPreserveContain: "全体表示＋黒帯",
	videoPreserveHelp: "自動の構図は切り抜かず、元映像全体を表示します。",
	videoPreserveBackgroundHelp:
		"余白をぼかし背景で埋めます。切り抜く場合は画面いっぱいを選びます。",
	videoPreserveDetails:
		"自動の構図や追跡結果は保存し、切り抜きを選ぶ際に利用できます。主映像に適用し、小窓や独自の配置は動かしません。",
	videoPreserveSummary:
		"ぼかし背景と黒帯は元映像全体を保ちます。画面いっぱいでは切り抜きます。",
	videoAuto: "自動で調整",
	videoAutoHelp: "設定済みの構図や追跡結果を使います。",
	videoAutoFallbackHelp: "それ以外は全体表示とぼかし背景で補います。",
	videoAutoDetails: "主映像に適用します。小窓や独自の配置は動かしません。",
	videoAutoBandsHelp:
		"ぼかし背景は主映像の領域だけに使い、字幕用の上下帯はそのまま残します。",
	videoFill: "画面いっぱいに表示",
	videoContain: "映像全体を表示（余白あり）",
	presentationDetails: "映像と字幕の配置について",
	videoFitSummary: "画面いっぱいは切り抜き、全体表示は余白を使って収めます。",
	captionPlacementSummary: "字幕を映像に重ねるか、上下に設けた帯へ配置します。",
	videoStaticHelp:
		"画面いっぱいでは追跡した構図を保ち、未追跡区間だけに固定構図を使います。全体表示では映像を切り抜きません。",
	videoStaticReferenceHelp:
		"AISAの位置情報がある場合は候補の参考にします。画面いっぱいで、場面ごとの候補を比較して選べます。",
	videoFitHelp:
		"画面いっぱいでは追跡した構図を使い、追跡できない区間は中央で切り抜きます。被写体が切れていないか確認してください。全体表示では原画を残すため余白が入ることがあります。",
	captionPlacement: "字幕の配置",
	captionOverlay: "映像に重ねる",
	captionBands: "上下に帯を設ける",
	captionPlacementHelp:
		"重ねる場合は字幕に背景を付けます。上下帯は字幕用の余白を確保し、字幕を消しても残ります。背景色と濃さは編集画面で変えられます。",
	trackingPreserveHelp:
		"追跡結果は保存し、後から切り抜きを選ぶ際に利用できます。全体表示では元映像を切り抜きません。",
	trackingStaticHelp:
		"実フレームで被写体の動きを追います。追跡できない区間は固定構図の候補で補います。",
	trackingFillHelp:
		"ショット内の実フレームから被写体を追います。追跡できない区間は画面の中央で切り抜くため、プレビューで構図を確認してください。",
	template: "最初の画面形式",
	portrait: "縦 · 9:16",
	landscape: "横 · 16:9",
	square: "正方形 · 1:1",
	variants: "生成する形式数",
	variantsHelp: "追加の形式は、同じ選択ショットを別の縦横比で作成します。",
	captions: "字幕を自動作成",
	captionMode: "字幕",
	captionsOff: "なし",
	captionsOriginal: "原語",
	captionsJapanese: "日本語訳",
	captionTranslationHelp:
		"発話を認識できた区間だけに字幕を付けます。日本語訳も元の字幕の時刻を使います。",
	captionTranslationUnavailable:
		"日本語訳はローカルモデルへの接続時に利用できます。",
	captionsHelp:
		"ローカルで音声認識します。単語単位の強調は実測の時刻がある場合だけ使います。",
	tracking: "映っている被写体を追う",
	trackingHelp:
		"各ショットの映像を測定します。追跡の信頼度が足りない区間は全体表示にします。",
	language: "音声の言語",
	auto: "自動判定",
	japanese: "日本語",
	english: "英語",
	start: "設定した内容で生成",
	starting: "開始しています…",
	unknown:
		"要求の結果を確認できませんでした。再試行では同じ要求キーを使います。",
	error: "操作を完了できませんでした。更新するか、もう一度お試しください。",
	dependencyUnavailable:
		"保存済みの文字起こし・追跡が、この素材・解析・選択範囲に対応していません。入力を確認し、新しく生成してください。",
	readOnly: "閲覧のみ可能です。生成や変更には操作権限が必要です。",
	associationTitle: "解析と素材の対応",
	loadingAssociation: "素材との対応を確認しています…",
	verified: "素材との対応が記録されています",
	captured: "キャプチャ時の入力同一性を検証済みです。",
	fixture:
		"サンプル用に作成されたメタデータです。実際の AISA キャプチャではありません。",
	attested: "操作員が時間・寸法・内容の対応を確認しています。",
	unverified:
		"この解析と準備済み素材の対応は未確認です。映像とシーン説明を照合してから確認を記録してください。",
	video: "対応確認用の準備済み映像",
	videoError:
		"素材映像を再生できませんでした。再読込してから確認してください。",
	time: "シーンの時刻がこの映像と一致することを確認しました。",
	geometry: "解像度・向き・被写体の座標を確認しました。",
	content: "シーン説明が映像の内容と一致することを確認しました。",
	confirm: "対応の確認を記録",
	confirming: "記録しています…",
	associationHelp:
		"人が照合した記録を保存します。プロバイダーが解析した入力の同一性を証明する操作ではありません。",
	scenes: "シーン説明",
	noScenes: "シーン説明がありません。",
	reload: "更新",
	resolution: "準備済み解像度",
	originalStart: "元映像の開始時刻",
	moreScenes:
		"先頭の 20 シーンを表示しています。残りは元の解析で確認してください。",
	progressTitle: "生成の進捗",
	loading: "生成状況を読み込んでいます…",
	queued: "待機中",
	preparing: "素材の準備を待っています",
	waitingCache: "同じ生成処理の完了を待っています",
	downloading: "準備済み素材を読み込んでいます",
	selecting: "ショットを選んでいます",
	analyzingStory: "取得できたAISAの物語記述を読み取っています",
	selectingStory: "出来事がつながる区間を選んでいます",
	transcribingStory: "構成に使う発話を文字起こししています",
	transcribingSections: "音声認識 {completed} / {total} 区間",
	analyzingLocalStory: "対象と出来事を整理しています",
	analyzingSections: "内容解析 {completed} / {total} 区間",
	planningLocalStory: "短編の構成を組み立てています",
	localStoryUnavailable:
		"自動構成を一時的に利用できません。少し待って再試行してください。",
	localStoryChanged:
		"自動構成の設定が更新されました。新しい編集案として作成してください。",
	localStoryContextLimit:
		"この素材を解析できる範囲を超えました。運用担当者に解析設定の確認を依頼してください。",
	localStoryPlanUnavailable:
		"希望尺に収まる構成を作れませんでした。尺や編集方針を変えて試してください。",
	localStoryCoherence:
		"選んだ場面のつながりを根拠付きで確認できませんでした。尺や場面の設定を変えて試してください。",
	localStoryDurationLimited:
		"根拠のある出来事のつながりを保つため、希望尺より短い案になっています。",
	localStoryUnverified:
		"解析結果の根拠を確認できませんでした。新しい編集案として再試行してください。",
	localStoryCancelUnconfirmed:
		"処理が停止したか確認できません。状況を再取得してから次の操作を行ってください。",
	storyEngineUnavailable:
		"物語の選定を利用できません。解析モデルの設定後に画面を更新してください。",
	storyGraphInvalid:
		"物語の解析結果を確認できませんでした。新しいタスクとして再試行してください。",
	storyModelChanged:
		"物語の解析モデルが更新されました。新しいタスクとして再試行してください。",
	transcribing: "音声を認識しています",
	aligningCaptions: "字幕を発話に合わせています",
	trackingPhase: "被写体を追跡しています",
	publishing: "プロジェクトを保存し書き出しを予約しています",
	running: "処理中",
	complete: "プロジェクトを作成しました",
	failed: "生成に失敗しました",
	canceled: "生成をキャンセルしました",
	cached: "同一の保存済み結果を再利用しました",
	resultHelp:
		"編集可能なプロジェクトを作成しました。結果を開くと MP4 の書き出し状況を確認でき、完了後に再生・ダウンロードできます。",
	cancel: "生成をキャンセル",
	canceling: "キャンセルを要求しています…",
	cancelRequested: "キャンセルを要求しました。処理の停止を待っています。",
	retry: "新しいタスクとして再試行",
	retrying: "再試行を開始しています…",
	warningTitle: "生成時の補足",
	durationLabel: "実際の尺 / 希望尺",
	result: "結果を開く",
	invalidResult:
		"保存された生成結果を検証できませんでした。このページを更新してください。",
	warningFallback:
		"一部の処理で代替表示を使いました。生成された内容を確認してください。",
	noAudio: "素材に音声がないため字幕を追加しませんでした。",
	noSpeech: "選択した音声で発話を検出できませんでした。",
	noModel: "音声認識が設定されていないため字幕を追加しませんでした。",
	segmentOnly: "発話との対応を確認できなかった字幕は省略しています。",
	clamped: "字幕区間の終端を実測した音声の長さに合わせました。",
	fit: "追跡できない区間があります。編集画面で構図を確認してください。",
	noShot: "追跡に使えるショット情報がありませんでした。",
	trackerChanged:
		"追跡処理が更新されました。新しいタスクとして再試行してください。",
	asrFailed:
		"検証可能な認識結果を得られなかったため、推測した字幕は追加しませんでした。",
};
export type ProductionCopy = Record<keyof typeof en, string>;
export function useProductionCopy(): ProductionCopy {
	return useT().locale === "ja" ? ja : en;
}
export function productionWarning(code: string, c: ProductionCopy): string {
	const key: Record<string, keyof ProductionCopy> = {
		SPEECH_DURATION_REVIEW_REQUIRED: "speechDurationReviewRequired",
		SPEECH_REVIEW_REQUIRED: "speechReviewRequired",
		SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED: "speechSearchLimitReviewReason",
		SPEECH_SELECTION_FALLBACK: "speechFallback",
		SPEECH_CONTEXT_LIMIT: "speechContextLimit",
		LOCAL_STORY_DURATION_LIMITED_BY_EVIDENCE: "localStoryDurationLimited",
		FIXTURE_METADATA: "fixture",
		EDITOR_ATTESTED_ASSOCIATION: "attested",
		SOURCE_HAS_NO_AUDIO: "noAudio",
		NO_SPEECH: "noSpeech",
		ASR_MODEL_NOT_CONFIGURED: "noModel",
		WORD_ALIGNMENT_UNAVAILABLE: "segmentOnly",
		CAPTION_ALIGNMENT_UNAVAILABLE: "segmentOnly",
		SEGMENT_END_CLAMPED: "clamped",
		TRACKING_FIT_FALLBACK: "fit",
		TRACKING_NO_SHOT_EVIDENCE: "noShot",
		TRANSCRIPT_INVALID: "asrFailed",
		TRANSCRIPT_LIMIT: "asrFailed",
		ASR_AUDIO_INVALID: "asrFailed",
		ASR_VERSION_MISMATCH: "asrFailed",
	};
	return c[key[code] ?? "warningFallback"];
}
export function productionPhase(phase: string, c: ProductionCopy): string {
	const key: Record<string, keyof ProductionCopy> = {
		QUEUED: "queued",
		WAITING_FOR_MEDIA: "preparing",
		WAITING_FOR_CACHE: "waitingCache",
		DOWNLOADING_SOURCE: "downloading",
		SELECTING_SHOTS: "selecting",
		ANALYZING_STORY: "analyzingStory",
		SELECTING_STORY: "selectingStory",
		TRANSCRIBING_STORY: "transcribingStory",
		ALIGNING_CAPTIONS: "aligningCaptions",
		ANALYZING_LOCAL_STORY: "analyzingLocalStory",
		PLANNING_LOCAL_STORY: "planningLocalStory",
		REFINING_SELECTION: "refining",
		TRANSCRIBING: "transcribing",
		TRACKING: "trackingPhase",
		PUBLISHING: "publishing",
		COMPLETE: "complete",
		CACHED: "cached",
		FAILED: "failed",
		CANCELED: "canceled",
	};
	return c[key[phase] ?? "running"];
}

export function productionFailure(
	code: string | null,
	c: ProductionCopy,
	fallback = c.error,
): string {
	switch (code) {
		case "LOCAL_SEMANTIC_UNAVAILABLE":
		case "LOCAL_STORY_ENGINE_UNAVAILABLE":
			return c.localStoryUnavailable;
		case "LOCAL_STORY_MODEL_CHANGED":
		case "GENERATION_POLICY_CHANGED":
			return c.localStoryChanged;
		case "LOCAL_STORY_CONTEXT_LIMIT":
			return c.localStoryContextLimit;
		case "LOCAL_STORY_PLAN_UNAVAILABLE":
			return c.localStoryPlanUnavailable;
		case "LOCAL_STORY_BLUEPRINT_COHERENCE_INVALID":
		case "LOCAL_STORY_SELECTION_COHERENCE_INVALID":
			return c.localStoryCoherence;
		case "LOCAL_SEMANTIC_RESPONSE_UNVERIFIED":
			return c.localStoryUnverified;
		case "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED":
			return c.localStoryCancelUnconfirmed;
		case "STORY_ENGINE_UNAVAILABLE":
			return c.storyEngineUnavailable;
		case "STORY_GRAPH_INVALID":
			return c.storyGraphInvalid;
		case "STORY_MODEL_CHANGED":
			return c.storyModelChanged;
		case "TRACKING_ALGORITHM_CHANGED":
		case "TRACKING_FRAME_CLOCK_CHANGED":
			return c.trackerChanged;
		case "TASK_DEPENDENCY_INVALID":
		case "TASK_RESULT_UNVERIFIED":
		case "TASK_DEPENDENCY_WINDOW_INCOMPLETE":
			return c.dependencyUnavailable;
		case "NO_SPEECH_SAFE_WINDOW":
			return c.noSpeechSafeWindow;
		case "SPEECH_SELECTION_POLICY_CHANGED":
			return c.speechSelectionChanged;
		case "NORMALIZATION_EVIDENCE_UNVERIFIED":
			return c.preparedClockUnavailable;
		default:
			return fallback;
	}
}
