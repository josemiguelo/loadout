package state

import (
	"fmt"
	"strconv"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/model"
)

// The state file's JSON, as kotlinx wrote it: every field in declaration
// order, nulls included (encodeDefaults), except configs, left out when
// empty; pretty-printed with a two-space indent. Unknown keys are ignored
// on read (contract 8).

// Encode is state's file content, final newline included.
func Encode(state coremodel.MachineState) string {
	var obj model.JSONObject
	schema := state.SchemaVersion
	if schema == 0 {
		schema = coremodel.SchemaVersion
	}
	obj.Set("schemaVersion", schema)
	obj.Set("machine", state.Machine)
	obj.Set("os", state.Os)
	obj.Set("distro", strOrNull(state.Distro))
	obj.Set("arch", state.Arch)
	obj.Set("toolVersion", state.ToolVersion)
	obj.Set("updatedAt", state.UpdatedAt)
	obj.Set("programs", model.MapValues(state.Programs, func(_ string, p coremodel.ProgramState) any {
		return model.MapOf[any](
			model.E[any]("status", string(p.Status)),
			model.E("version", strOrNull(p.Version)),
			model.E("reason", strOrNull(p.Reason)),
		)
	}))
	obj.Set("scripts", model.MapValues(state.Scripts, func(_ string, s coremodel.ScriptState) any {
		var exit any
		if s.ExitCode != nil {
			exit = *s.ExitCode
		}
		return model.MapOf[any](
			model.E[any]("status", string(s.Status)),
			model.E("lastRun", strOrNull(s.LastRun)),
			model.E("exitCode", exit),
		)
	}))
	if !state.Configs.IsEmpty() {
		obj.Set("configs", model.MapValues(state.Configs, func(_ string, c coremodel.ConfigState) any {
			files := c.Files
			if files == nil {
				files = []string{}
			}
			return model.MapOf[any](
				model.E[any]("status", string(c.Status)),
				model.E[any]("files", files),
				model.E("reason", strOrNull(c.Reason)),
			)
		}))
	}
	return model.PrettyJSON(obj) + "\n"
}

func strOrNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// Decode reads a state file's content.
func Decode(text string) (coremodel.MachineState, error) {
	tree, err := model.ParseJSON(text)
	if err != nil {
		return coremodel.MachineState{}, err
	}
	d := decoder{}
	state := d.machineState(tree)
	return state, d.err
}

// decoder reads the tree; the first problem sticks.
type decoder struct{ err error }

func (d *decoder) fail(format string, args ...any) {
	if d.err == nil {
		d.err = fmt.Errorf(format, args...)
	}
}

func (d *decoder) object(v any, path, what string) model.JSONObject {
	obj, ok := v.(model.JSONObject)
	if !ok {
		d.fail("Expected JsonObject as the serialized body of %s at element: %s", what, path)
	}
	return obj
}

func (d *decoder) required(obj model.JSONObject, key, path, what string) any {
	v, ok := obj.Get(key)
	if !ok {
		d.fail("Field '%s' is required for type with serial name '%s', but it was missing at path: %s", key, what, path)
	}
	return v
}

func (d *decoder) str(v any, path string) string {
	s, ok := v.(string)
	if !ok {
		d.fail("Expected a string at element: %s", path)
	}
	return s
}

func (d *decoder) reqStr(obj model.JSONObject, key, path, what string) string {
	v := d.required(obj, key, path, what)
	if d.err != nil {
		return ""
	}
	return d.str(v, path+"."+key)
}

func (d *decoder) optStr(obj model.JSONObject, key, path string) *string {
	v, ok := obj.Get(key)
	if !ok || v == nil {
		return nil
	}
	s := d.str(v, path+"."+key)
	return &s
}

func (d *decoder) integer(v any, path string) int {
	content := fmt.Sprint(v)
	n, err := strconv.Atoi(content)
	if _, isString := v.(string); isString || err != nil {
		d.fail("Expected an int at element: %s", path)
	}
	return n
}

func objectsOf[V any](d *decoder, obj model.JSONObject, key, path string, read func(v any, path string) V) model.Map[V] {
	v, ok := obj.Get(key)
	if !ok {
		return model.Map[V]{}
	}
	entries := d.object(v, path+"."+key, "kotlin.collections.LinkedHashMap")
	return model.MapValues(entries, func(k string, e any) V { return read(e, path+"."+key+"."+k) })
}

func (d *decoder) status(v any, path string, allowed ...string) string {
	s := d.str(v, path)
	for _, a := range allowed {
		if s == a {
			return s
		}
	}
	if d.err == nil {
		d.fail("unknown status '%s' at element: %s", s, path)
	}
	return s
}

const serial = "loadout.core.model."

func (d *decoder) machineState(v any) coremodel.MachineState {
	obj := d.object(v, "$", serial+"MachineState")
	if d.err != nil {
		return coremodel.MachineState{}
	}
	state := coremodel.MachineState{SchemaVersion: coremodel.SchemaVersion}
	if s, ok := obj.Get("schemaVersion"); ok {
		state.SchemaVersion = d.integer(s, "$.schemaVersion")
	}
	state.Machine = d.reqStr(obj, "machine", "$", serial+"MachineState")
	state.Os = d.reqStr(obj, "os", "$", serial+"MachineState")
	state.Distro = d.optStr(obj, "distro", "$")
	state.Arch = d.reqStr(obj, "arch", "$", serial+"MachineState")
	state.ToolVersion = d.reqStr(obj, "toolVersion", "$", serial+"MachineState")
	state.UpdatedAt = d.reqStr(obj, "updatedAt", "$", serial+"MachineState")
	state.Programs = objectsOf(d, obj, "programs", "$", func(v any, path string) coremodel.ProgramState {
		o := d.object(v, path, serial+"ProgramState")
		status := d.required(o, "status", path, serial+"ProgramState")
		return coremodel.ProgramState{
			Status:  coremodel.ProgramStatus(d.status(status, path+".status", "installed", "missing", "unknown")),
			Version: d.optStr(o, "version", path),
			Reason:  d.optStr(o, "reason", path),
		}
	})
	state.Scripts = objectsOf(d, obj, "scripts", "$", func(v any, path string) coremodel.ScriptState {
		o := d.object(v, path, serial+"ScriptState")
		status := d.required(o, "status", path, serial+"ScriptState")
		s := coremodel.ScriptState{
			Status:  coremodel.ScriptStatus(d.status(status, path+".status", "done", "failed", "pending")),
			LastRun: d.optStr(o, "lastRun", path),
		}
		if e, ok := o.Get("exitCode"); ok && e != nil {
			n := d.integer(e, path+".exitCode")
			s.ExitCode = &n
		}
		return s
	})
	state.Configs = objectsOf(d, obj, "configs", "$", func(v any, path string) coremodel.ConfigState {
		o := d.object(v, path, serial+"ConfigState")
		status := d.required(o, "status", path, serial+"ConfigState")
		c := coremodel.ConfigState{
			Status: coremodel.ConfigStatus(d.status(status, path+".status", "applied", "drifted", "unknown")),
			Reason: d.optStr(o, "reason", path),
		}
		if f, ok := o.Get("files"); ok {
			list, isList := f.([]any)
			if !isList {
				d.fail("Expected JsonArray at element: %s.files", path)
			}
			for i, e := range list {
				c.Files = append(c.Files, d.str(e, fmt.Sprintf("%s.files[%d]", path, i)))
			}
		}
		return c
	})
	return state
}
