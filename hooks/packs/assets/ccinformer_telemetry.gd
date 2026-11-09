# CCInformer telemetry, added to this project by CCInformer's /ccinformer pack install-telemetry after you agreed.
# It does nothing in an exported or headless build, or unless the project's .local/telemetry/ folder exists (CCInformer
# creates it only when git ignores it). It writes only into that folder: telemetry.json (FPS, frame times, errors)
# once a second, and a screenshot when CCInformer asks for one, keeping the newest 10.
# To remove it: delete this file and its line under [autoload] in project.godot.
extends Node

const DIR := "res://.local/telemetry"
const SCHEMA := 1
const MAX_SAMPLES := 120
const MAX_ERRORS := 20
const MAX_SHOTS := 10
const MAX_SHOT_WIDTH := 1280
const REQUEST_MAX_AGE_MS := 5000
const CAPTURE_DEADLINE_MS := 3000
const SAMPLE_EVERY_MS := 1000
const REQUEST_EVERY_MS := 500
const MSG_MAX := 300
const SHOT_NAME := "^shot-[0-9]{13}\\.png$"
const ID_NAME := "^[0-9]{13}$"

# Godot 4.5 and later report errors to a Logger. It is compiled from this text at runtime, so the file still parses on
# an older engine, which then reports no errors. Its callbacks may run on other threads, so they only fill a buffer.
const SINK_SOURCE := """extends Logger

var lock := Mutex.new()
var entries: Array = []

func _take(kind: String, msg: String) -> void:
	lock.lock()
	if entries.size() < 50:
		entries.append({"t": int(Time.get_unix_time_from_system() * 1000.0), "kind": kind, "msg": msg})
	lock.unlock()

func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
	if error_type == 1:
		return
	var text := rationale if rationale != "" else code
	if file != "":
		text += " (%s:%d)" % [file, line]
	_take(["error", "error", "script", "shader"][clampi(error_type, 0, 3)], text)

func _log_message(message: String, error: bool) -> void:
	if error:
		_take("stderr", message.strip_edges())

func drain() -> Array:
	lock.lock()
	var out := entries
	entries = []
	lock.unlock()
	return out
"""

var _on := false
var _dir := ""
var _doc := {}
var _samples: Array = []
var _errors: Array = []
var _error_count := 0
var _sink = null
var _shot_name := RegEx.new()
var _id_name := RegEx.new()
var _next_sample := 0
var _next_request := 0
var _bad_request_seen := false
var _capture_gen := 0
var _capture_id := ""
var _capture_until := 0
var _encode_task := -1
var _encoded := {}


func _init() -> void:
	_dir = ProjectSettings.globalize_path(DIR)
	_on = not OS.has_feature("template") and DisplayServer.get_name() != "headless" and _dir != DIR and DirAccess.dir_exists_absolute(_dir)
	if not _on:
		return
	_shot_name.compile(SHOT_NAME)
	_id_name.compile(ID_NAME)
	_doc = {"schema": SCHEMA, "startedAt": _now(), "errorSource": "none", "errorCount": 0, "samples": [], "errors": [], "screenshot": null}
	if ClassDB.class_exists("Logger"):
		var script := GDScript.new()
		script.source_code = SINK_SOURCE
		if script.reload() == OK:
			_sink = script.new()
			OS.call("add_logger", _sink)
			_doc["errorSource"] = "logger"


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_process(_on)


func _exit_tree() -> void:
	if _encode_task >= 0:
		WorkerThreadPool.wait_for_task_completion(_encode_task)
		_encode_task = -1
	if _sink != null:
		OS.call("remove_logger", _sink)
		_sink = null


func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec()
	if _encode_task >= 0 and WorkerThreadPool.is_task_completed(_encode_task):
		_finish_encode()
	if now >= _next_request:
		_next_request = now + REQUEST_EVERY_MS
		_check_capture_deadline(now)
		_check_request()
	if now >= _next_sample:
		_next_sample = now + SAMPLE_EVERY_MS
		_sample()
		_drain()
		_write()


func _now() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)


# Godot's process and physics times are the slowest frame of the last second (vsync wait included), not an average,
# so the fields say so.
func _sample() -> void:
	_samples.append({
		"t": _now(),
		"fps": snappedf(Performance.get_monitor(Performance.TIME_FPS), 0.1),
		"slowestFrameMs": snappedf(Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0, 0.1),
		"slowestPhysicsMs": snappedf(Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0, 0.1),
		"drawCalls": int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
		"objects": int(Performance.get_monitor(Performance.OBJECT_COUNT)),
		"memMb": snappedf(Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0, 0.1),
	})
	while _samples.size() > MAX_SAMPLES:
		_samples.pop_front()


# The logger's buffer into the file: the autoload's own failed file calls left out, a repeat within the same second
# kept once, the newest MAX_ERRORS kept.
func _drain() -> void:
	if _sink == null:
		return
	var last := ""
	for e in _sink.drain():
		var msg := String(e["msg"])
		if msg.contains(".local/telemetry") or msg.contains(".local\\telemetry"):
			continue
		_error_count += 1
		var key := "%s|%d" % [msg, int(e["t"]) / 1000]
		if key == last:
			continue
		last = key
		_errors.append({"t": int(e["t"]), "kind": String(e["kind"]), "msg": msg.substr(0, MSG_MAX)})
	while _errors.size() > MAX_ERRORS:
		_errors.pop_front()


# The whole file, written beside it and renamed over it, so a reader never sees half of it. A failed write is left for
# the next second; a folder deleted meanwhile stops every write.
func _write() -> void:
	_doc["samples"] = _samples
	_doc["errors"] = _errors
	_doc["errorCount"] = _error_count
	var tmp := _dir + "/telemetry.json.tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify(_doc))
	f.close()
	DirAccess.rename_absolute(tmp, _dir + "/telemetry.json")


# CCInformer's request.json: {"id": "<13 digits, Unix ms>", "kind": "screenshot"}. Text that doesn't parse yet is tried
# again once (CCInformer may still be writing it); a request is removed before it is answered.
func _check_request() -> void:
	var path := _dir + "/request.json"
	if not FileAccess.file_exists(path):
		_bad_request_seen = false
		return
	var json := JSON.new()
	if json.parse(FileAccess.get_file_as_string(path)) != OK:
		if _bad_request_seen:
			DirAccess.remove_absolute(path)
		_bad_request_seen = not _bad_request_seen
		return
	_bad_request_seen = false
	DirAccess.remove_absolute(path)
	var req = json.data
	if typeof(req) != TYPE_DICTIONARY or req.get("kind") != "screenshot":
		return
	var id := String(req.get("id", ""))
	if _id_name.search(id) == null:
		_answer(id.substr(0, 13), "bad request")
		return
	if _now() - id.to_int() > REQUEST_MAX_AGE_MS or _capture_until > 0 or _encode_task >= 0:
		return
	if not DisplayServer.window_can_draw():
		_answer(id, "window not drawn")
		return
	_capture_gen += 1
	_capture_id = id
	_capture_until = Time.get_ticks_msec() + CAPTURE_DEADLINE_MS
	_capture(id, _capture_gen)


# A capture that never gets its frame (no window drawing) gives up after CAPTURE_DEADLINE_MS.
func _check_capture_deadline(now: int) -> void:
	if _capture_until > 0 and now > _capture_until:
		_capture_until = 0
		_capture_gen += 1
		_answer(_capture_id, "capture failed")


# Only the read back from the GPU happens on the main thread; the convert, resize and PNG save run on a worker, so a
# screenshot doesn't stall a frame. The main thread picks up the result in _process once the task has finished.
func _capture(id: String, gen: int) -> void:
	await RenderingServer.frame_post_draw
	if gen != _capture_gen or _capture_until == 0:
		return
	_capture_until = 0
	var image := get_viewport().get_texture().get_image()
	if image == null or image.is_empty():
		_answer(id, "capture failed")
		return
	_encoded = {}
	_encode_task = WorkerThreadPool.add_task(_encode.bind(image, id), false, "CCInformer screenshot")


# On a worker thread: touches only its own image and writes its result to _encoded, which the main thread reads only
# after the task has finished.
func _encode(image: Image, id: String) -> void:
	image.convert(Image.FORMAT_RGB8)
	var w := image.get_width()
	var h := image.get_height()
	if w > MAX_SHOT_WIDTH:
		h = int(round(h * float(MAX_SHOT_WIDTH) / w))
		w = MAX_SHOT_WIDTH
		image.resize(w, h, Image.INTERPOLATE_BILINEAR)
	var file := "shot-%s.png" % id
	_encoded = {"id": id, "file": file, "width": w, "height": h, "ok": image.save_png(_dir + "/" + file) == OK}


func _finish_encode() -> void:
	WorkerThreadPool.wait_for_task_completion(_encode_task)
	_encode_task = -1
	var r := _encoded
	if not r.get("ok", false):
		_answer(String(r.get("id", _capture_id)), "save failed")
		return
	_doc["screenshot"] = {"id": r["id"], "file": r["file"], "t": _now(), "width": r["width"], "height": r["height"]}
	_write()
	_prune()


func _answer(id: String, error: String) -> void:
	_doc["screenshot"] = {"id": id, "file": "", "t": _now(), "error": error}
	_write()


# Only this script's own screenshots (shot-<13 digits>.png) are ever removed, oldest first, keeping the newest MAX_SHOTS.
func _prune() -> void:
	var shots: Array = []
	for name in DirAccess.get_files_at(_dir):
		if _shot_name.search(name) != null:
			shots.append(name)
	shots.sort()
	while shots.size() > MAX_SHOTS:
		DirAccess.remove_absolute(_dir + "/" + String(shots.pop_front()))
