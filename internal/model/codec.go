package model

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
)

// The lock's JSON shape, field by field, as kotlinx writes the @Serializable
// classes with encodeDefaults = false and explicitNulls = false: keys in
// declaration order, a field equal to its default left out, a nil one too.
// Reading is strict like kotlinx's: an unknown key or a missing required
// field is an error naming its path.

// ─── writing ────────────────────────────────────────────────────────────

type objWriter struct{ obj JSONObject }

func (w *objWriter) any(key string, v any) { w.obj.Set(key, v) }
func (w *objWriter) str(key, v string)     { w.obj.Set(key, v) }
func (w *objWriter) strIf(key, v string) {
	if v != "" {
		w.obj.Set(key, v)
	}
}
func (w *objWriter) ptr(key string, v *string) {
	if v != nil {
		w.obj.Set(key, *v)
	}
}
func (w *objWriter) flag(key string, v bool) {
	if v {
		w.obj.Set(key, true)
	}
}
func (w *objWriter) list(key string, v []string) {
	if len(v) > 0 {
		w.obj.Set(key, strings2any(v))
	}
}
func (w *objWriter) strMap(key string, v Map[string]) {
	if !v.IsEmpty() {
		w.obj.Set(key, MapValues(v, func(_ string, s string) any { return s }))
	}
}
func (w *objWriter) data(key string, v JSONObject) {
	if !v.IsEmpty() {
		w.obj.Set(key, v)
	}
}

func objectsOf[V any](m Map[V], f func(V) JSONObject) JSONObject {
	return MapValues(m, func(_ string, v V) any { return f(v) })
}

func (m Manifest) toJSON() JSONObject {
	var w objWriter
	if m.Meta.Name != "" || m.Meta.MinToolVersion != nil {
		w.any("meta", m.Meta.toJSON())
	}
	if !m.Layout.isDefault() {
		w.any("layout", m.Layout.toJSON())
	}
	if !m.Installers.IsEmpty() {
		w.any("installers", objectsOf(m.Installers, Installer.toJSON))
	}
	if !m.Programs.IsEmpty() {
		w.any("programs", objectsOf(m.Programs, Program.toJSON))
	}
	if !m.Scripts.IsEmpty() {
		w.any("scripts", objectsOf(m.Scripts, ScriptStep.toJSON))
	}
	if !m.Machines.IsEmpty() {
		w.any("machines", objectsOf(m.Machines, MachineConfig.toJSON))
	}
	if !m.Outdated.IsEmpty() {
		w.any("outdated", objectsOf(m.Outdated, OutdatedSource.toJSON))
	}
	w.list("builtinInstallers", m.BuiltinInstallers)
	w.data("data", m.Data)
	return w.obj
}

func (m Meta) toJSON() JSONObject {
	var w objWriter
	w.strIf("name", m.Name)
	w.ptr("min-tool-version", m.MinToolVersion)
	return w.obj
}

func (l RepoLayout) isDefault() bool {
	return l.State == "" && l.Configs == nil && len(l.Sources) == 0 && l.Parent == nil
}

func (l RepoLayout) toJSON() JSONObject {
	var w objWriter
	w.strIf("state", l.State)
	w.ptr("configs", l.Configs)
	w.list("sources", l.Sources)
	if l.Parent != nil {
		w.any("parent", l.Parent.toJSON())
	}
	return w.obj
}

func (p ParentLayout) toJSON() JSONObject {
	var w objWriter
	w.str("name", p.Name)
	w.str("path", p.Path)
	w.str("state", p.State)
	w.ptr("configs", p.Configs)
	w.list("sources", p.Sources)
	w.strIf("hash", p.Hash)
	return w.obj
}

func (i Installer) toJSON() JSONObject {
	var w objWriter
	w.ptr("probe", i.Probe)
	w.list("params", i.Params)
	w.ptr("install", i.Install)
	w.ptr("check", i.Check)
	w.ptr("regex", i.Regex)
	w.ptr("outdated", i.Outdated)
	w.ptr("outdated-all", i.OutdatedAll)
	w.ptr("upgrade", i.Upgrade)
	w.flag("sudo", i.Sudo)
	w.list("requires", i.Requires)
	w.strIf("origin", i.Origin)
	return w.obj
}

func (v InstallVariant) toJSON() JSONObject {
	var w objWriter
	w.ptr("installer", v.Installer)
	w.ptr("pkg", v.Pkg)
	w.ptr("command", v.Command)
	w.ptr("check", v.Check)
	w.ptr("regex", v.Regex)
	w.flag("present", v.Present)
	w.ptr("probe", v.Probe)
	w.ptr("outdated", v.Outdated)
	w.strMap("with", v.With)
	if v.Sudo != nil {
		w.any("sudo", *v.Sudo)
	}
	w.list("depends-on", v.DependsOn)
	if len(v.Provides) > 0 {
		list := make([]any, len(v.Provides))
		for i, p := range v.Provides {
			var pw objWriter
			pw.str("binary", p.Binary)
			pw.ptr("at", p.At)
			list[i] = pw.obj
		}
		w.any("provides", list)
	}
	return w.obj
}

func (c MachineConfig) toJSON() JSONObject {
	var w objWriter
	w.list("extends", c.Extends)
	w.strMap("pm", c.PM)
	w.list("scripts", c.Scripts)
	w.strMap("script-variants", c.ScriptVariants)
	w.data("data", c.Data)
	return w.obj
}

func (p Program) toJSON() JSONObject {
	var w objWriter
	w.strIf("description", p.Description)
	w.list("tags", p.Tags)
	w.list("depends-on", p.DependsOn)
	if p.Version != nil {
		w.any("version", p.Version.toJSON())
	}
	if !p.Install.IsEmpty() {
		w.any("install", objectsOf(p.Install, InstallVariant.toJSON))
	}
	if p.Outdated != nil {
		var ow objWriter
		ow.str("command", p.Outdated.Command)
		ow.ptr("upgrade", p.Outdated.Upgrade)
		w.any("outdated", ow.obj)
	}
	w.list("path", p.Path)
	w.strIf("origin", p.Origin)
	return w.obj
}

func (v VersionCheck) toJSON() JSONObject {
	var w objWriter
	w.str("command", v.Command)
	w.ptr("regex", v.Regex)
	w.strIf("origin", v.Origin)
	w.list("path", v.Path)
	return w.obj
}

func (s ScriptStep) toJSON() JSONObject {
	var w objWriter
	w.strIf("description", s.Description)
	w.ptr("file", s.File)
	w.ptr("run", s.Run)
	w.ptr("check", s.Check)
	w.list("after", s.After)
	if s.Modes != nil && !slices.Equal(s.Modes, defaultModes) {
		w.any("modes", strings2any(s.Modes))
	}
	w.flag("sudo", s.Sudo)
	if !s.Variants.IsEmpty() {
		w.any("variants", objectsOf(s.Variants, ScriptStep.toJSON))
	}
	w.strIf("origin", s.Origin)
	return w.obj
}

func (o OutdatedSource) toJSON() JSONObject {
	var w objWriter
	w.ptr("command", o.Command)
	w.ptr("upgrade", o.Upgrade)
	w.flag("sudo", o.Sudo)
	w.strIf("origin", o.Origin)
	return w.obj
}

// ─── reading ────────────────────────────────────────────────────────────

// decodeError is a lock that doesn't fit the model, worded like kotlinx's.
type decodeError struct{ msg string }

func (e *decodeError) Error() string { return e.msg }

// objReader reads one object's fields; the first problem sticks, and done
// reports it or the first key nothing read.
type objReader struct {
	obj    JSONObject
	path   string
	serial string
	seen   map[string]bool
	err    *error
}

func newReader(v any, path, serial string, err *error) *objReader {
	r := &objReader{path: path, serial: serial, seen: map[string]bool{}, err: err}
	obj, ok := v.(JSONObject)
	if !ok && *err == nil {
		*err = &decodeError{fmt.Sprintf("Expected JsonObject, but had %s as the serialized body of %s at element: %s", kindOf(v), serial, path)}
	}
	r.obj = obj
	return r
}

func kindOf(v any) string {
	switch v.(type) {
	case JSONObject:
		return "JsonObject"
	case []any:
		return "JsonArray"
	case nil:
		return "JsonNull"
	}
	return "JsonLiteral"
}

func (r *objReader) fail(format string, args ...any) {
	if *r.err == nil {
		*r.err = &decodeError{fmt.Sprintf(format, args...)}
	}
}

// get is key's value; a null counts as absent (explicitNulls = false).
func (r *objReader) get(key string) (any, bool) {
	r.seen[key] = true
	v, ok := r.obj.Get(key)
	if !ok || v == nil {
		return nil, false
	}
	return v, true
}

func (r *objReader) at(key string) string { return r.path + "." + key }

func (r *objReader) required(key string) (any, bool) {
	v, ok := r.get(key)
	if !ok {
		r.fail("Field '%s' is required for type with serial name '%s', but it was missing at path: %s", key, r.serial, r.path)
	}
	return v, ok
}

func (r *objReader) asString(key string, v any) string {
	s, ok := v.(string)
	if !ok {
		r.fail("String literal for key '%s' should be quoted at element: %s", key, r.at(key))
	}
	return s
}

func (r *objReader) reqStr(key string) string {
	v, ok := r.required(key)
	if !ok {
		return ""
	}
	return r.asString(key, v)
}

func (r *objReader) str(key string) string {
	v, ok := r.get(key)
	if !ok {
		return ""
	}
	return r.asString(key, v)
}

func (r *objReader) ptr(key string) *string {
	v, ok := r.get(key)
	if !ok {
		return nil
	}
	s := r.asString(key, v)
	return &s
}

func (r *objReader) asBool(key string, v any) bool {
	b, ok := v.(bool)
	if !ok {
		r.fail("Boolean literal for key '%s' expected at element: %s", key, r.at(key))
	}
	return b
}

func (r *objReader) flag(key string) bool {
	v, ok := r.get(key)
	return ok && r.asBool(key, v)
}

func (r *objReader) optFlag(key string) *bool {
	v, ok := r.get(key)
	if !ok {
		return nil
	}
	b := r.asBool(key, v)
	return &b
}

func (r *objReader) array(key string) ([]any, bool) {
	v, ok := r.get(key)
	if !ok {
		return nil, false
	}
	arr, isArr := v.([]any)
	if !isArr {
		r.fail("Expected JsonArray, but had %s as the serialized body of kotlin.collections.ArrayList at element: %s", kindOf(v), r.at(key))
		return nil, false
	}
	return arr, true
}

func (r *objReader) list(key string) []string {
	arr, ok := r.array(key)
	if !ok {
		return nil
	}
	out := make([]string, len(arr))
	for i, e := range arr {
		s, isStr := e.(string)
		if !isStr {
			r.fail("String literal for key '%d' should be quoted at element: %s[%d]", i, r.at(key), i)
		}
		out[i] = s
	}
	return out
}

func (r *objReader) object(key string) (JSONObject, bool) {
	v, ok := r.get(key)
	if !ok {
		return JSONObject{}, false
	}
	obj, isObj := v.(JSONObject)
	if !isObj {
		r.fail("Expected JsonObject, but had %s as the serialized body of kotlin.collections.LinkedHashMap at element: %s", kindOf(v), r.at(key))
	}
	return obj, isObj
}

func (r *objReader) strMap(key string) Map[string] {
	obj, ok := r.object(key)
	if !ok {
		return Map[string]{}
	}
	return MapValues(obj, func(k string, v any) string {
		s, isStr := v.(string)
		if !isStr {
			r.fail("String literal for key '%s' should be quoted at element: %s", k, r.at(key)+"."+k)
		}
		return s
	})
}

func (r *objReader) data(key string) JSONObject {
	obj, _ := r.object(key)
	return obj
}

func readMap[V any](r *objReader, key string, read func(v any, path string, err *error) V) Map[V] {
	obj, ok := r.object(key)
	if !ok {
		return Map[V]{}
	}
	return MapValues(obj, func(k string, v any) V { return read(v, r.at(key)+"."+k, r.err) })
}

// done reports the first unknown key.
func (r *objReader) done() {
	for k := range r.obj.All() {
		if !r.seen[k] {
			r.fail("Encountered an unknown key '%s' at path: %s", k, r.path)
			return
		}
	}
}

func readManifest(v any, path string, err *error) Manifest {
	r := newReader(v, path, "loadout.core.model.Manifest", err)
	var m Manifest
	if meta, ok := r.get("meta"); ok {
		mr := newReader(meta, r.at("meta"), "loadout.core.model.Meta", err)
		m.Meta = Meta{Name: mr.str("name"), MinToolVersion: mr.ptr("min-tool-version")}
		mr.done()
	}
	if layout, ok := r.get("layout"); ok {
		m.Layout = readLayout(layout, r.at("layout"), err)
	}
	m.Installers = readMap(r, "installers", readInstaller)
	m.Programs = readMap(r, "programs", readProgram)
	m.Scripts = readMap(r, "scripts", readScript)
	m.Machines = readMap(r, "machines", readMachine)
	m.Outdated = readMap(r, "outdated", readOutdated)
	m.BuiltinInstallers = distinct(r.list("builtinInstallers"))
	m.Data = r.data("data")
	r.done()
	return m
}

func readLayout(v any, path string, err *error) RepoLayout {
	r := newReader(v, path, "loadout.core.model.RepoLayout", err)
	l := RepoLayout{State: r.str("state"), Configs: r.ptr("configs"), Sources: r.list("sources")}
	if parent, ok := r.get("parent"); ok {
		pr := newReader(parent, r.at("parent"), "loadout.core.model.ParentLayout", err)
		l.Parent = &ParentLayout{
			Name: pr.reqStr("name"), Path: pr.reqStr("path"), State: pr.reqStr("state"),
			Configs: pr.ptr("configs"), Sources: pr.list("sources"), Hash: pr.str("hash"),
		}
		pr.done()
	}
	r.done()
	return l
}

func readInstaller(v any, path string, err *error) Installer {
	r := newReader(v, path, "loadout.core.model.Installer", err)
	i := Installer{
		Probe: r.ptr("probe"), Params: r.list("params"), Install: r.ptr("install"), Check: r.ptr("check"),
		Regex: r.ptr("regex"), Outdated: r.ptr("outdated"), OutdatedAll: r.ptr("outdated-all"),
		Upgrade: r.ptr("upgrade"), Sudo: r.flag("sudo"), Requires: r.list("requires"), Origin: r.str("origin"),
	}
	r.done()
	return i
}

func readVariant(v any, path string, err *error) InstallVariant {
	r := newReader(v, path, "loadout.core.model.InstallVariant", err)
	iv := InstallVariant{
		Installer: r.ptr("installer"), Pkg: r.ptr("pkg"), Command: r.ptr("command"), Check: r.ptr("check"),
		Regex: r.ptr("regex"), Present: r.flag("present"), Probe: r.ptr("probe"), Outdated: r.ptr("outdated"),
		With: r.strMap("with"), Sudo: r.optFlag("sudo"), DependsOn: r.list("depends-on"),
	}
	if arr, ok := r.array("provides"); ok {
		for n, e := range arr {
			pr := newReader(e, fmt.Sprintf("%s[%d]", r.at("provides"), n), "loadout.core.model.Provides", err)
			iv.Provides = append(iv.Provides, Provides{Binary: pr.reqStr("binary"), At: pr.ptr("at")})
			pr.done()
		}
	}
	r.done()
	return iv
}

func readMachine(v any, path string, err *error) MachineConfig {
	r := newReader(v, path, "loadout.core.model.MachineConfig", err)
	c := MachineConfig{
		Extends: r.list("extends"), PM: r.strMap("pm"), Scripts: r.list("scripts"),
		ScriptVariants: r.strMap("script-variants"), Data: r.data("data"),
	}
	r.done()
	return c
}

func readCheck(v any, path string, err *error) *VersionCheck {
	r := newReader(v, path, "loadout.core.model.VersionCheck", err)
	c := &VersionCheck{Command: r.reqStr("command"), Regex: r.ptr("regex"), Origin: r.str("origin"), Path: r.list("path")}
	r.done()
	return c
}

func readProgram(v any, path string, err *error) Program {
	r := newReader(v, path, "loadout.core.model.Program", err)
	p := Program{Description: r.str("description"), Tags: r.list("tags"), DependsOn: r.list("depends-on")}
	if version, ok := r.get("version"); ok {
		p.Version = readCheck(version, r.at("version"), err)
	}
	p.Install = readMap(r, "install", readVariant)
	if outdated, ok := r.get("outdated"); ok {
		or := newReader(outdated, r.at("outdated"), "loadout.core.model.ProgramOutdated", err)
		p.Outdated = &ProgramOutdated{Command: or.reqStr("command"), Upgrade: or.ptr("upgrade")}
		or.done()
	}
	p.Path = r.list("path")
	p.Origin = r.str("origin")
	r.done()
	return p
}

func readScript(v any, path string, err *error) ScriptStep {
	r := newReader(v, path, "loadout.core.model.ScriptStep", err)
	s := ScriptStep{
		Description: r.str("description"), File: r.ptr("file"), Run: r.ptr("run"), Check: r.ptr("check"),
		After: r.list("after"),
	}
	if _, ok := r.array("modes"); ok {
		s.Modes = r.list("modes")
	}
	s.Sudo = r.flag("sudo")
	s.Variants = readMap(r, "variants", readScript)
	s.Origin = r.str("origin")
	r.done()
	return s
}

func readOutdated(v any, path string, err *error) OutdatedSource {
	r := newReader(v, path, "loadout.core.model.OutdatedSource", err)
	o := OutdatedSource{Command: r.ptr("command"), Upgrade: r.ptr("upgrade"), Sudo: r.flag("sudo"), Origin: r.str("origin")}
	r.done()
	return o
}

func readLock(tree JSONObject, err *error) Lock {
	r := newReader(tree, "$", "loadout.core.manifest.Lock", err)
	var lock Lock
	lock.Format = LockFormat
	if f, ok := r.get("format"); ok {
		n, isNum := f.(json.Number)
		parsed, perr := strconv.Atoi(string(n))
		if !isNum || perr != nil {
			r.fail("Unexpected JSON token at element: $.format")
		}
		lock.Format = parsed
	}
	lock.ToolVersion = r.reqStr("toolVersion")
	lock.Sources = r.reqStr("sources")
	if m, ok := r.required("manifest"); ok {
		lock.Manifest = readManifest(m, "$.manifest", err)
	}
	r.done()
	return lock
}
