// Package hclconf is loadout's front end: the repo's HCL manifests
// (`loadout.hcl` and the `*.loadout.hcl` files its sources globs match),
// decoded into an assemble.ManifestDraft with every rule the manifest
// language owns, and `loadout compile`, which assembles the draft and writes
// the lock.
package hclconf

import (
	"path"
	"slices"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/ext/userfunc"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"

	"github.com/josemiguelo/loadout/internal/assemble"
	"github.com/josemiguelo/loadout/internal/model"
)

// VersionRegex is the default version regex: the first dotted number in the output.
const VersionRegex = `([0-9]+\.[0-9][0-9.]*)`

// EntryFile is the manifest at the repo root that holds the repo block. It
// is always compiled.
const EntryFile = "loadout.hcl"

// File is one manifest file.
type File struct {
	// Path is the file's path relative to its repo's root, slash-separated:
	// its folder is its declarations' origin.
	Path string
	Src  []byte
	// Name is what diagnostics call the file; Path when empty.
	Name string
}

// Options says whose files are being decoded.
type Options struct {
	// AsParent decodes a child repo's parent: every origin is a parent's
	// (model.ParentOrigin).
	AsParent bool
	// Parent is a child repo's parent, decoded: the child's files refer to
	// its declarations by name, and its data schema is the child's.
	Parent *Decoded
}

// ParentRef is `repo { parent { name, path } }`: a child repo's parent, as written.
type ParentRef struct{ Name, Path string }

// Decoded is what a repo's manifests declare.
type Decoded struct {
	// Draft is the declarations, ready for assemble (a child's own, without
	// its parent's: see DraftOver). Meaningful only when Errors is empty.
	Draft assemble.ManifestDraft
	// Errors is the mistakes the manifest language catches beyond HCL's
	// (a name declared twice, a program installed without saying how),
	// refused together as "Invalid manifest:" (assemble.Invalid).
	Errors []string
	// Spares is what `spare = "reason"` marked, keyed as warnings name it
	// ("program 'x'", "program 'x' via 'brew'", "script 'x' as 'arch'").
	Spares model.Map[string]
	// Transitional is the scripts marked `transitional = true`, in declaration order.
	Transitional []string
	// Sources is `repo.sources`, as written.
	Sources []string
	// Parent is `repo.parent`, nil for a repo without one.
	Parent *ParentRef

	schema *dataSchema
	// variants is each program's install variant keys, in order.
	variants map[string][]string
}

// DraftOf is d's draft, or the refusal listing its errors.
func (d *Decoded) DraftOf() (assemble.ManifestDraft, error) {
	if len(d.Errors) > 0 {
		return assemble.ManifestDraft{}, assemble.Invalid(model.Distinct(d.Errors))
	}
	return d.Draft, nil
}

// DraftOver is a child repo's draft over its parent's (contract 18): the
// child's errors, then the parent's (each prefixed "parent <name>: "), then
// the merge's, refused together.
func (d *Decoded) DraftOver(parent *Decoded, parentName string) (assemble.ManifestDraft, error) {
	errors := slices.Clone(d.Errors)
	for _, e := range parent.Errors {
		errors = append(errors, "parent "+parentName+": "+e)
	}
	draft, merge := assemble.DraftOver(d.Draft, parent.Draft, parentName)
	errors = append(errors, merge...)
	if len(errors) > 0 {
		return assemble.ManifestDraft{}, assemble.Invalid(model.Distinct(errors))
	}
	return draft, nil
}

// Decode is what files declare, decoded in two passes: every block's label
// first (the namespace references evaluate against), then every
// attribute. The error is HCL's diagnostics (a *DiagnosticsError), all of
// them; the language's own rules land in Decoded.Errors.
func Decode(files []File, opts Options) (*Decoded, error) {
	d := &decoder{opts: opts, out: &Decoded{variants: map[string][]string{}}}
	// A syntax error leaves the namespace unknown: nothing past it is worth saying.
	if syntax := d.parse(files); syntax.HasErrors() {
		return nil, diagnosticsError(syntax)
	}
	d.namespace()
	d.decodeFunctions()
	d.decodeLocals()
	d.decodeRepo()
	if opts.Parent != nil && d.schema == nil {
		d.schema = opts.Parent.schema
	}
	for _, phase := range [][]string{{"installer", "requires", "program", "script", "outdated"}, {"profile", "machine"}} {
		for _, b := range d.blocks {
			if slices.Contains(phase, b.block.Type) {
				d.declare(b)
			}
		}
	}
	if d.diags.HasErrors() {
		return nil, diagnosticsError(d.diags)
	}
	d.out.Errors = d.errors
	d.out.schema = d.schema
	return d.out, nil
}

// block is a top-level block and the file it's in.
type block struct {
	block  *hclsyntax.Block
	origin string
}

type decoder struct {
	opts   Options
	out    *Decoded
	diags  hcl.Diagnostics
	errors []string

	bodies []*hclsyntax.Body
	blocks []block
	entry  *hclsyntax.Body

	ctx    *hcl.EvalContext
	schema *dataSchema

	installers, programs, scripts, profiles []string
}

// topLevel is what a manifest file holds: blocks only, each with its labels.
var topLevel = spec{blocks: map[string][2]int{
	"repo": {0, 0}, "data": {0, 0}, "locals": {0, 0}, "function": {1, 1},
	"installer": {1, 1}, "requires": {1, 1}, "program": {1, 1}, "script": {1, 1},
	"outdated": {1, 1}, "profile": {1, 1}, "machine": {1, 1},
}}

func (d *decoder) parse(files []File) hcl.Diagnostics {
	var syntax hcl.Diagnostics
	for _, f := range files {
		name := f.Name
		if name == "" {
			name = f.Path
		}
		file, diags := hclsyntax.ParseConfig(f.Src, name, hcl.InitialPos)
		syntax = append(syntax, diags...)
		if diags.HasErrors() {
			continue
		}
		body := file.Body.(*hclsyntax.Body)
		d.diags = append(d.diags, topLevel.check(body, "a manifest file")...)
		folder := path.Dir(f.Path)
		if folder == "." {
			folder = ""
		}
		origin := folder
		if d.opts.AsParent {
			origin = model.ParentOrigin(folder)
		} else if d.opts.Parent != nil && model.IsParentOrigin(folder) && !slices.Contains(d.errors, "a child repo's folder can't start with "+model.OriginParent+": "+folder) {
			d.errors = append(d.errors, "a child repo's folder can't start with "+model.OriginParent+": "+folder)
		}
		d.bodies = append(d.bodies, body)
		isEntry := f.Path == EntryFile
		if isEntry {
			d.entry = body
		}
		for _, b := range body.Blocks {
			if _, ok := topLevel.blocks[b.Type]; !ok || len(checkLabels(b, topLevel.blocks[b.Type])) > 0 {
				continue
			}
			if b.Type == "repo" && !isEntry {
				d.diags = append(d.diags, diag(b.TypeRange, "Misplaced repo block", "The repo block belongs in %s, at the repo root.", EntryFile))
				continue
			}
			d.blocks = append(d.blocks, block{b, origin})
		}
	}
	return syntax
}

// namespace is the first pass: every label, as the reference values
// expressions evaluate against.
func (d *decoder) namespace() {
	add := func(list *[]string, names ...string) {
		for _, n := range names {
			if !slices.Contains(*list, n) {
				*list = append(*list, n)
			}
		}
	}
	add(&d.installers, model.InstallerLibraryNames()...)
	if p := d.opts.Parent; p != nil {
		add(&d.installers, p.Draft.Manifest.Installers.Keys()...)
		add(&d.programs, p.Draft.Manifest.Programs.Keys()...)
		add(&d.scripts, p.Draft.Manifest.Scripts.Keys()...)
		add(&d.profiles, p.Draft.Profiles.Keys()...)
		for name, vs := range p.variants {
			d.out.variants[name] = vs
		}
	}
	for _, b := range d.blocks {
		switch b.block.Type {
		case "installer":
			add(&d.installers, b.block.Labels[0])
		case "program":
			add(&d.programs, b.block.Labels[0])
		case "script":
			add(&d.scripts, b.block.Labels[0])
		case "profile":
			add(&d.profiles, b.block.Labels[0])
		}
	}
	objectOf := func(kind string, names []string) cty.Value {
		vals := map[string]cty.Value{}
		for _, n := range names {
			vals[n] = refVal(kind, n)
		}
		return cty.ObjectVal(vals)
	}
	vars := map[string]cty.Value{
		"program":   objectOf("program", d.programs),
		"script":    objectOf("script", d.scripts),
		"profile":   objectOf("profile", d.profiles),
		"installer": objectOf("installer", d.installers),
		"local":     cty.EmptyObjectVal,
	}
	// Every installer is a bare name too: `install_via = [brew, omarchy]`.
	for _, n := range d.installers {
		if _, taken := vars[n]; !taken {
			vars[n] = refVal("installer", n)
		}
	}
	d.ctx = &hcl.EvalContext{Variables: vars, Functions: functions()}
}

// decodeFunctions is every file's `function` blocks (ext/userfunc), callable
// from any file.
func (d *decoder) decodeFunctions() {
	seen := map[string]hcl.Range{}
	for _, b := range d.blocks {
		if b.block.Type != "function" {
			continue
		}
		name := b.block.Labels[0]
		if at, dup := seen[name]; dup {
			d.diags = append(d.diags, diag(b.block.LabelRanges[0], "Duplicate function", "A function named %q is already declared at %s:%d,%d.", name, at.Filename, at.Start.Line, at.Start.Column))
		} else if _, builtin := d.ctx.Functions[name]; builtin {
			d.diags = append(d.diags, diag(b.block.LabelRanges[0], "Function name taken", "%q is a built-in function.", name))
		}
		seen[name] = b.block.LabelRanges[0]
	}
	for _, body := range d.bodies {
		funcs, _, diags := userfunc.DecodeUserFunctions(body, "function", func() *hcl.EvalContext { return d.ctx })
		d.diags = append(d.diags, diags...)
		for name, f := range funcs {
			if _, builtin := functions()[name]; !builtin {
				d.ctx.Functions[name] = f
			}
		}
	}
}

// decodeLocals evaluates every `locals` block's values, each after the
// locals it names; a cycle is an error naming them.
func (d *decoder) decodeLocals() {
	attrs := map[string]*hclsyntax.Attribute{}
	var order []string
	for _, b := range d.blocks {
		if b.block.Type != "locals" {
			continue
		}
		d.diags = append(d.diags, spec{}.checkBlocksOnly(b.block.Body, "locals")...)
		for _, a := range sortedAttrs(b.block.Body) {
			if prev, dup := attrs[a.Name]; dup {
				d.diags = append(d.diags, diag(a.NameRange, "Duplicate local value", "A local value named %q was already declared at %s:%d,%d. Local value names must be unique.", a.Name, prev.NameRange.Filename, prev.NameRange.Start.Line, prev.NameRange.Start.Column))
				continue
			}
			attrs[a.Name] = a
			order = append(order, a.Name)
		}
	}
	deps := func(name string) []string {
		var out []string
		for _, t := range attrs[name].Expr.Variables() {
			if t.RootName() != "local" || len(t) < 2 {
				continue
			}
			if step, ok := t[1].(hcl.TraverseAttr); ok && attrs[step.Name] != nil && !slices.Contains(out, step.Name) {
				out = append(out, step.Name)
			}
		}
		return out
	}
	values := map[string]cty.Value{}
	state := map[string]int{} // 1 visiting, 2 done
	var stack []string
	var visit func(name string) bool
	visit = func(name string) bool {
		switch state[name] {
		case 2:
			_, ok := values[name]
			return ok
		case 1:
			at := slices.Index(stack, name)
			cycle := append(slices.Clone(stack[at:]), name)
			for i := range cycle {
				cycle[i] = "local." + cycle[i]
			}
			d.diags = append(d.diags, diag(attrs[name].NameRange, "Cycle among locals", "%s refer to each other: %s.", strings.Join(model.Distinct(cycle), ", "), strings.Join(cycle, " -> ")))
			return false
		}
		state[name] = 1
		stack = append(stack, name)
		ok := true
		for _, dep := range deps(name) {
			if !visit(dep) {
				ok = false
			}
		}
		stack = stack[:len(stack)-1]
		state[name] = 2
		if !ok {
			return false
		}
		d.ctx.Variables["local"] = cty.ObjectVal(values)
		v, diags := attrs[name].Expr.Value(d.ctx)
		d.diags = append(d.diags, diags...)
		if diags.HasErrors() {
			return false
		}
		values[name] = v
		return true
	}
	for _, name := range order {
		visit(name)
	}
	d.ctx.Variables["local"] = cty.ObjectVal(values)
}

// checkBlocksOnly reports any block in body: locals hold values only.
func (spec) checkBlocksOnly(body *hclsyntax.Body, where string) hcl.Diagnostics {
	var diags hcl.Diagnostics
	for _, b := range body.Blocks {
		diags = append(diags, diag(b.TypeRange, "Unsupported block type", "Blocks of type %q are not expected in %s.", b.Type, where))
	}
	return diags
}

var repoSpec = spec{
	attrs:  []string{"name", "state", "configs", "min_tool_version", "sources"},
	blocks: map[string][2]int{"parent": {0, 0}},
}

// decodeRepo is the repo block and the data schema.
func (d *decoder) decodeRepo() {
	var repo, data *hclsyntax.Block
	for _, b := range d.blocks {
		switch b.block.Type {
		case "repo":
			if repo != nil {
				d.diags = append(d.diags, diag(b.block.TypeRange, "Duplicate repo block", "A repo has one repo block."))
				continue
			}
			repo = b.block
		case "data":
			if data != nil {
				d.diags = append(d.diags, diag(b.block.TypeRange, "Duplicate data block", "The data schema is one data block, at %s:%d,%d.", data.TypeRange.Filename, data.TypeRange.Start.Line, data.TypeRange.Start.Column))
				continue
			}
			data = b.block
		}
	}
	draft := &d.out.Draft
	if repo != nil {
		body := repo.Body
		d.diags = append(d.diags, repoSpec.check(body, "the repo block")...)
		if d.required(repo, "state") {
			draft.Manifest.Layout.State = d.text(body, "state")
		}
		draft.Manifest.Meta = model.Meta{Name: d.text(body, "name"), MinToolVersion: d.str(body, "min_tool_version")}
		draft.Manifest.Layout.Configs = d.str(body, "configs")
		d.out.Sources = d.strings(body, "sources")
		for _, p := range body.Blocks {
			if p.Type != "parent" {
				continue
			}
			if d.out.Parent != nil {
				d.diags = append(d.diags, diag(p.TypeRange, "Duplicate parent block", "A child repo has one parent."))
				continue
			}
			pb := p.Body
			d.diags = append(d.diags, spec{attrs: []string{"name", "path"}}.check(pb, "the parent block")...)
			if d.required(p, "name") && d.required(p, "path") {
				d.out.Parent = &ParentRef{Name: d.text(pb, "name"), Path: d.text(pb, "path")}
			}
		}
	}
	if data != nil {
		d.schema, draft.Manifest.Data = d.decodeSchema(data.Body)
	}
}

// declare decodes one declaration.
func (d *decoder) declare(b block) {
	name := b.block.Labels[0]
	body := b.block.Body
	switch b.block.Type {
	case "installer":
		d.declareInstaller(name, body, b.origin)
	case "requires":
		d.declareRequires(b.block)
	case "program":
		d.declareProgram(name, body, b.origin)
	case "script":
		d.declareScript(name, body, b.origin)
	case "outdated":
		d.diags = append(d.diags, outdatedSpec.check(body, "an outdated block")...)
		if d.required(b.block, "command") {
			d.addOutdated(name, d.outdatedSource(body, b.origin))
		}
	case "profile", "machine":
		d.declareMachine(b.block.Type, name, body)
	}
}

func add[V any](d *decoder, kind, name string, m *model.Map[V], value V) {
	if m.Has(name) {
		d.errors = append(d.errors, "duplicate "+kind+" '"+name+"'")
	}
	m.Set(name, value)
}

func (d *decoder) spare(body *hclsyntax.Body, key string) {
	if reason := d.str(body, "spare"); reason != nil {
		d.out.Spares.Set(key, *reason)
	}
}

// ─── Installers ────────────────────────────────────────────────────────

var installerSpec = spec{attrs: []string{
	"probe", "install", "check", "regex", "outdated", "outdated_all", "upgrade", "needs_sudo", "params", "spare",
}}

func (d *decoder) declareInstaller(name string, body *hclsyntax.Body, origin string) {
	d.diags = append(d.diags, installerSpec.check(body, "an installer")...)
	regex := d.str(body, "regex")
	if regex == nil {
		regex = model.Ptr(VersionRegex)
	}
	installer := model.Installer{
		Probe:       d.str(body, "probe"),
		Params:      d.strings(body, "params"),
		Install:     d.str(body, "install"),
		Check:       d.str(body, "check"),
		Regex:       regex,
		Outdated:    d.str(body, "outdated"),
		OutdatedAll: d.str(body, "outdated_all"),
		Upgrade:     d.str(body, "upgrade"),
		Sudo:        d.isTrue(body, "needs_sudo"),
		Origin:      origin,
	}
	d.spare(body, "installer '"+name+"'")
	add(d, "installer", name, &d.out.Draft.Manifest.Installers, installer)
}

// installerLabel says label names an installer, reporting it otherwise.
func (d *decoder) installerLabel(b *hclsyntax.Block) bool {
	name := b.Labels[0]
	if slices.Contains(d.installers, name) {
		return true
	}
	d.diags = append(d.diags, diag(b.LabelRanges[0], "Unknown installer", "There is no installer named %q (built-in or declared).", name))
	return false
}

func (d *decoder) declareRequires(b *hclsyntax.Block) {
	d.diags = append(d.diags, spec{attrs: []string{"programs"}}.check(b.Body, "a requires block")...)
	if !d.installerLabel(b) {
		return
	}
	name := b.Labels[0]
	programs := names(d.plainRefs(b.Body, "programs", "program"))
	requires := &d.out.Draft.Requires
	requires.Set(name, append(slices.Clone(requires.Value(name)), programs...))
}

// ─── Programs ──────────────────────────────────────────────────────────

var programSpec = spec{
	attrs: []string{
		"description", "tags", "depends_on", "version", "regex", "path", "outdated", "upgrade",
		"updates_managed_by", "spare", "install_via",
	},
	blocks: map[string][2]int{"via": {1, 1}, "custom": {0, 1}},
}

var variantSpec = spec{
	attrs: []string{
		"pkg", "command", "installed_by", "managed_by", "version", "present", "regex", "probe", "outdated",
		"needs_sudo", "depends_on", "params", "spare",
	},
	blocks: map[string][2]int{"provides": {1, 1}},
}

func (d *decoder) declareProgram(name string, body *hclsyntax.Body, origin string) {
	d.diags = append(d.diags, programSpec.check(body, "a program")...)
	program := model.Program{
		Description: d.text(body, "description"),
		Tags:        d.strings(body, "tags"),
		DependsOn:   model.Distinct(names(d.plainRefs(body, "depends_on", "program"))),
		Path:        d.strings(body, "path"),
		Origin:      origin,
	}
	if command := d.str(body, "version"); command != nil {
		regex := d.str(body, "regex")
		if regex == nil {
			regex = model.Ptr(VersionRegex)
		}
		program.Version = &model.VersionCheck{Command: *command, Regex: regex, Origin: origin, Path: program.Path}
	} else if a := body.Attributes["regex"]; a != nil {
		d.diags = append(d.diags, diag(a.NameRange, "Regex without version", "A program's regex reads its version command's output: set version too."))
	}
	d.conflict(body, "outdated", "updates_managed_by")
	if script := d.str(body, "updates_managed_by"); script != nil {
		program.Outdated = &model.ProgramOutdated{Command: "file:" + *script, Upgrade: model.Ptr("file:" + *script + " update")}
		if a := body.Attributes["upgrade"]; a != nil {
			d.diags = append(d.diags, diag(a.NameRange, "Conflicting arguments", "updates_managed_by updates through its script (`<script> update`): drop upgrade."))
		}
	} else if command := d.str(body, "outdated"); command != nil {
		program.Outdated = &model.ProgramOutdated{Command: *command, Upgrade: d.str(body, "upgrade")}
	} else if a := body.Attributes["upgrade"]; a != nil {
		d.diags = append(d.diags, diag(a.NameRange, "Upgrade without outdated", "upgrade moves the program outdated says is behind: set outdated too."))
	}

	// Variants in the order they're written, across install_via and blocks.
	type variant struct {
		key   string
		start int
		v     model.InstallVariant
		spare *string
	}
	var variants []variant
	for _, r := range d.plainRefs(body, "install_via", "installer") {
		variants = append(variants, variant{key: r.name, start: r.at.Start.Byte})
	}
	for _, b := range body.Blocks {
		key := "custom"
		switch b.Type {
		case "via":
			if !d.installerLabel(b) {
				continue
			}
			key = b.Labels[0]
		case "custom":
			if len(b.Labels) == 1 {
				key = b.Labels[0]
			}
		default:
			continue
		}
		v, spare := d.installVariant(b.Body)
		variants = append(variants, variant{key: key, start: b.TypeRange.Start.Byte, v: v, spare: spare})
	}
	slices.SortStableFunc(variants, func(a, b variant) int { return a.start - b.start })
	for _, v := range variants {
		if program.Install.Has(v.key) {
			d.errors = append(d.errors, "program '"+name+"' has two '"+v.key+"' variants")
		}
		program.Install.Set(v.key, v.v)
		if v.spare != nil {
			d.out.Spares.Set("program '"+name+"' via '"+v.key+"'", *v.spare)
		}
	}
	d.spare(body, "program '"+name+"'")
	if !d.out.Draft.Manifest.Programs.Has(name) {
		d.out.variants[name] = program.Install.Keys()
	}
	add(d, "program", name, &d.out.Draft.Manifest.Programs, program)
}

// installVariant is a `via` or `custom` block's body.
func (d *decoder) installVariant(body *hclsyntax.Body) (model.InstallVariant, *string) {
	d.diags = append(d.diags, variantSpec.check(body, "an install variant")...)
	d.conflict(body, "version", "present", "managed_by")
	d.conflict(body, "command", "installed_by", "managed_by")
	v := model.InstallVariant{
		Pkg:       d.str(body, "pkg"),
		Command:   d.str(body, "command"),
		Probe:     d.str(body, "probe"),
		Outdated:  d.str(body, "outdated"),
		Sudo:      d.boolean(body, "needs_sudo"),
		DependsOn: model.Distinct(names(d.plainRefs(body, "depends_on", "program"))),
		Regex:     d.str(body, "regex"),
	}
	if script := d.str(body, "installed_by"); script != nil {
		v.Command = model.Ptr("file:" + *script)
	}
	switch {
	case body.Attributes["managed_by"] != nil:
		if script := d.str(body, "managed_by"); script != nil {
			v.Command = model.Ptr("file:" + *script + " install")
			v.Check = model.Ptr("file:" + *script + " check")
			// A regex reads a version from `<script> check`; without one, it's a yes/no check.
			v.Present = v.Regex == nil
		}
	case body.Attributes["version"] != nil:
		v.Check = d.str(body, "version")
		if v.Regex == nil {
			v.Regex = model.Ptr(VersionRegex)
		}
	case body.Attributes["present"] != nil:
		v.Check = d.str(body, "present")
		v.Present = true
	}
	if attr := body.Attributes["params"]; attr != nil {
		v.With = d.params(attr)
	}
	for _, b := range body.Blocks {
		if b.Type != "provides" {
			continue
		}
		d.diags = append(d.diags, spec{attrs: []string{"at"}}.check(b.Body, "a provides block")...)
		v.Provides = append(v.Provides, model.Provides{Binary: b.Labels[0], At: d.str(b.Body, "at")})
	}
	return v, d.str(body, "spare")
}

// params is a variant's `params = { name = value }`, in the order written.
func (d *decoder) params(attr *hclsyntax.Attribute) model.Map[string] {
	var out model.Map[string]
	obj, ok := attr.Expr.(*hclsyntax.ObjectConsExpr)
	if !ok {
		v := d.value(attr)
		if v == nil {
			return out
		}
		if t := v.Type(); !(t.IsObjectType() || t.IsMapType()) {
			d.typeError(attr, "object of strings")
			return out
		}
		for it := v.ElementIterator(); it.Next(); {
			k, e := it.Element()
			if e.IsNull() || e.Type() != cty.String {
				d.typeError(attr, "object of strings")
				return out
			}
			out.Set(k.AsString(), e.AsString())
		}
		return out
	}
	for _, item := range obj.Items {
		k, diags := item.KeyExpr.Value(d.ctx)
		d.diags = append(d.diags, diags...)
		v, vdiags := item.ValueExpr.Value(d.ctx)
		d.diags = append(d.diags, vdiags...)
		if diags.HasErrors() || vdiags.HasErrors() {
			continue
		}
		if k.IsNull() || k.Type() != cty.String || v.IsNull() || v.Type() != cty.String {
			d.diags = append(d.diags, diag(item.ValueExpr.Range(), "Incorrect param value", "A param is a name and a string value: params = { copr = \"x/y\" }."))
			continue
		}
		out.Set(k.AsString(), v.AsString())
	}
	return out
}

// ─── Scripts ───────────────────────────────────────────────────────────

var scriptSpec = spec{
	attrs: []string{
		"description", "file", "run", "check", "managed_by", "needs_sudo", "setup_only", "maintain_only",
		"transitional", "spare", "updates_managed_by", "run_after",
	},
	blocks: map[string][2]int{"outdated": {0, 0}, "variant": {1, 1}},
}

var scriptVariantSpec = spec{attrs: []string{"file", "run", "check", "managed_by", "run_after", "spare", "transitional"}}

var outdatedSpec = spec{attrs: []string{"name", "command", "upgrade", "needs_sudo"}}

func (d *decoder) declareScript(name string, body *hclsyntax.Body, origin string) {
	d.diags = append(d.diags, scriptSpec.check(body, "a script")...)
	step := d.scriptStep(body, origin)
	step.Description = d.text(body, "description")
	step.Sudo = d.isTrue(body, "needs_sudo")
	d.conflict(body, "setup_only", "maintain_only")
	if d.isTrue(body, "setup_only") {
		step.Modes = []string{"setup"}
	} else if d.isTrue(body, "maintain_only") {
		step.Modes = []string{"maintain"}
	}

	type source struct {
		name  string
		start int
		s     model.OutdatedSource
	}
	var sources []source
	if a := body.Attributes["updates_managed_by"]; a != nil {
		if script := d.str(body, "updates_managed_by"); script != nil {
			sources = append(sources, source{name, a.SrcRange.Start.Byte, model.OutdatedSource{
				Command: model.Ptr("file:" + *script), Upgrade: model.Ptr("file:" + *script + " update {item}"), Origin: origin,
			}})
		}
	}
	for _, b := range body.Blocks {
		switch b.Type {
		case "outdated":
			d.diags = append(d.diags, outdatedSpec.check(b.Body, "an outdated block")...)
			if !d.required(b, "command") {
				continue
			}
			sourceName := name
			if n := d.str(b.Body, "name"); n != nil {
				sourceName = *n
			}
			sources = append(sources, source{sourceName, b.TypeRange.Start.Byte, d.outdatedSource(b.Body, origin)})
		case "variant":
			variant := b.Labels[0]
			d.diags = append(d.diags, scriptVariantSpec.check(b.Body, "a script variant")...)
			if d.isTrue(b.Body, "transitional") {
				d.errors = append(d.errors, "script '"+name+"': transitional = true goes on the script, not on its '"+variant+"' variant")
			}
			if step.Variants.Has(variant) {
				d.errors = append(d.errors, "a script has two '"+variant+"' variants")
			}
			step.Variants.Set(variant, d.scriptStep(b.Body, origin))
			if reason := d.str(b.Body, "spare"); reason != nil {
				d.out.Spares.Set("script '"+name+"' as '"+variant+"'", *reason)
			}
		}
	}
	d.spare(body, "script '"+name+"'")
	add(d, "script", name, &d.out.Draft.Manifest.Scripts, step)
	if d.isTrue(body, "transitional") {
		if !slices.Contains(d.out.Transitional, name) {
			d.out.Transitional = append(d.out.Transitional, name)
		}
		checkless := step.Check == nil
		if checkless && !step.Variants.IsEmpty() {
			checkless = false
			for v := range step.Variants.Values() {
				checkless = checkless || v.Check == nil
			}
		}
		if checkless {
			d.errors = append(d.errors, "script '"+name+"' is transitional, so it needs a check: it's done when the check passes")
		}
	}
	slices.SortStableFunc(sources, func(a, b source) int { return a.start - b.start })
	for _, s := range sources {
		d.addOutdated(s.name, s.s)
	}
}

// scriptStep is what a script and each of its variants say: file or run,
// check, run_after.
func (d *decoder) scriptStep(body *hclsyntax.Body, origin string) model.ScriptStep {
	d.conflict(body, "file", "managed_by")
	d.conflict(body, "check", "managed_by")
	step := model.ScriptStep{File: d.str(body, "file"), Origin: origin}
	if run := d.commands(body, "run"); run != nil {
		step.Run = model.Ptr(allOf(run))
	}
	if check := d.commands(body, "check"); check != nil {
		step.Check = model.Ptr(allOf(check))
	}
	if script := d.str(body, "managed_by"); script != nil {
		// The machine's arguments reach the check too.
		step.File = script
		step.Check = model.Ptr("file:" + *script + ` check "$@"`)
	}
	var after []string
	for _, r := range d.plainRefs(body, "run_after", "program", "script") {
		after = append(after, r.kind+"s."+r.name)
	}
	step.After = model.Distinct(after)
	return step
}

// allOf is commands joined with `&&`. One holding `||` or `;` is grouped in
// `{ …; }` first, so the join can't change what it means (contract 4).
func allOf(commands []string) string {
	parts := make([]string, len(commands))
	for i, c := range commands {
		if strings.Contains(c, "||") || strings.Contains(c, ";") {
			c = "{ " + c + "; }"
		}
		parts[i] = c
	}
	return strings.Join(parts, " && ")
}

func (d *decoder) outdatedSource(body *hclsyntax.Body, origin string) model.OutdatedSource {
	return model.OutdatedSource{
		Command: d.str(body, "command"),
		Upgrade: d.str(body, "upgrade"),
		Sudo:    d.isTrue(body, "needs_sudo"),
		Origin:  origin,
	}
}

func (d *decoder) addOutdated(name string, source model.OutdatedSource) {
	add(d, "outdated source", name, &d.out.Draft.Manifest.Outdated, source)
}

// ─── Machines and profiles ─────────────────────────────────────────────

var machineSpec = spec{
	attrs:  []string{"extends", "data", "spare", "install", "run"},
	blocks: map[string][2]int{"via": {1, 1}},
}

// declareMachine is a machine or a profile: the
// same body, two verbs (install, run) and `via` blocks, and contract 2's
// rules.
func (d *decoder) declareMachine(kind, name string, body *hclsyntax.Body) {
	label := kind + " '" + name + "'"
	d.diags = append(d.diags, machineSpec.check(body, "a "+kind)...)
	config := model.MachineConfig{
		Extends: names(d.plainRefs(body, "extends", "profile")),
		Label:   label,
	}
	if body.Attributes["spare"] != nil {
		if kind == "machine" {
			d.errors = append(d.errors, label+" is marked spare, but only a profile can be: a machine is used by being declared")
		} else {
			d.spare(body, label)
		}
	}
	mapProgram := func(program, variant string) {
		if config.PM.Has(program) {
			d.errors = append(d.errors, label+" installs '"+program+"' twice")
		}
		config.PM.Set(program, variant)
	}

	// install and via blocks, in the order they're written.
	type part struct {
		start int
		apply func()
	}
	var parts []part
	if a := body.Attributes["install"]; a != nil {
		parts = append(parts, part{a.SrcRange.Start.Byte, func() {
			for _, r := range d.refs(body, "install", "program") {
				switch variants := d.out.variants[r.name]; {
				case len(r.args) > 0:
					d.diags = append(d.diags, diag(r.at, "Arguments on a program", "args() is for scripts: install takes programs."))
				case r.variant != "":
					mapProgram(r.name, r.variant)
				case len(variants) == 1:
					mapProgram(r.name, variants[0])
				case len(variants) == 0:
					d.errors = append(d.errors, label+" installs '"+r.name+"', which has no install variants")
				default:
					d.errors = append(d.errors, label+" installs '"+r.name+"' without saying how (it has: "+strings.Join(variants, ", ")+")")
				}
			}
		}})
	}
	for _, b := range body.Blocks {
		if b.Type != "via" {
			continue
		}
		parts = append(parts, part{b.TypeRange.Start.Byte, func() {
			d.diags = append(d.diags, spec{attrs: []string{"install"}}.check(b.Body, "a via block")...)
			if !d.installerLabel(b) {
				return
			}
			installer := b.Labels[0]
			for _, r := range d.refs(b.Body, "install", "program") {
				if r.variant != "" || len(r.args) > 0 {
					d.diags = append(d.diags, diag(r.at, "A variant in via", "via %q installs each program as its %s variant: name the program alone.", installer, installer))
					continue
				}
				mapProgram(r.name, installer)
			}
		}})
	}
	slices.SortStableFunc(parts, func(a, b part) int { return a.start - b.start })
	for _, p := range parts {
		p.apply()
	}

	for _, r := range d.refs(body, "run", "script") {
		if r.variant != "" {
			config.ScriptVariants.Set(r.name, r.variant)
		}
		twice := false
		for _, entry := range config.Scripts {
			if n, _ := model.ScriptEntry(entry); n == r.name {
				twice = true
			}
		}
		if twice {
			d.errors = append(d.errors, label+" runs '"+r.name+"' twice")
			continue
		}
		config.Scripts = append(config.Scripts, strings.Join(append([]string{r.name}, r.args...), " "))
	}
	config.Data = d.decodeMachineData(body, label)
	if kind == "machine" {
		add(d, "machine", name, &d.out.Draft.Manifest.Machines, config)
	} else {
		add(d, "profile", name, &d.out.Draft.Profiles, config)
	}
}

// ManifestOf is the manifest files declare, assembled without checking
// `file:` paths, with state in `state/` unless they say otherwise.
// TEST-ONLY (contract 10): how engine and screen tests build fixtures;
// everything else (built-ins, flattening, validation) is the production
// path.
func ManifestOf(files ...File) (model.Manifest, error) {
	decoded, err := Decode(files, Options{})
	if err != nil {
		return model.Manifest{}, err
	}
	draft, err := decoded.DraftOf()
	if err != nil {
		return model.Manifest{}, err
	}
	if strings.TrimSpace(draft.Manifest.Layout.State) == "" {
		draft.Manifest.Layout.State = "state"
	}
	return assemble.AssembleWithoutFiles(draft)
}
