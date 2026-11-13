package model

import "fmt"

// A manifest draft as JSON, in the lock's own shapes: the manifest as the
// lock writes it (before assembly: machines unflattened, built-ins not
// merged), plus the profiles and the installers' extra requires. What a
// repo's loadout.ts prints (the SDK's repo()) for compile to assemble.

// EncodeDraft is the draft's JSON.
func EncodeDraft(m Manifest, profiles Map[MachineConfig], requires Map[[]string]) string {
	var w objWriter
	w.any("manifest", m.toJSON())
	if !profiles.IsEmpty() {
		w.any("profiles", objectsOf(profiles, MachineConfig.toJSON))
	}
	if !requires.IsEmpty() {
		w.any("requires", MapValues(requires, func(_ string, v []string) any { return strings2any(v) }))
	}
	return PrettyJSON(w.obj) + "\n"
}

// DecodeDraft reads EncodeDraft's JSON.
func DecodeDraft(text string) (Manifest, Map[MachineConfig], Map[[]string], error) {
	tree, err := ParseJSON(text)
	if err != nil {
		return Manifest{}, Map[MachineConfig]{}, Map[[]string]{}, err
	}
	var derr error
	r := newReader(tree, "draft", "draft", &derr)
	var m Manifest
	if v, ok := r.get("manifest"); ok {
		m = readManifest(v, "draft.manifest", &derr)
	}
	var profiles Map[MachineConfig]
	if obj, ok := r.object("profiles"); ok {
		for name, v := range obj.All() {
			profiles.Set(name, readMachine(v, "draft.profiles."+name, &derr))
		}
	}
	var requires Map[[]string]
	if obj, ok := r.object("requires"); ok {
		for name := range obj.All() {
			rr := newReader(obj, "draft.requires", "requires", &derr)
			requires.Set(name, rr.list(name))
		}
	}
	if derr != nil {
		return Manifest{}, profiles, requires, fmt.Errorf("the manifest's draft can't be read: %w", derr)
	}
	return m, profiles, requires, nil
}
