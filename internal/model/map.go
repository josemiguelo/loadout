package model

import (
	"iter"
	"slices"
)

// Map is a string-keyed map that keeps insertion order, as Kotlin's maps
// do: the lock writes keys in the order they were declared (or sorted, when
// the assembler sorts them), so order is part of the model.
//
// The zero value is an empty map. Set changes the map in place, and a copied
// Map shares its entries with the original: build a new one (or Clone)
// rather than setting into a map another value holds.
type Map[V any] struct {
	keys   []string
	values map[string]V
}

// Entry is one key and value, for MapOf.
type Entry[V any] struct {
	Key   string
	Value V
}

// E is an Entry, short for map literals: MapOf(E("a", 1), E("b", 2)).
func E[V any](key string, value V) Entry[V] { return Entry[V]{key, value} }

// MapOf is a map of entries, in order; a repeated key keeps its first place
// and its last value.
func MapOf[V any](entries ...Entry[V]) Map[V] {
	var m Map[V]
	for _, e := range entries {
		m.Set(e.Key, e.Value)
	}
	return m
}

// Len is the number of entries.
func (m Map[V]) Len() int { return len(m.keys) }

// IsEmpty says whether the map has no entries.
func (m Map[V]) IsEmpty() bool { return len(m.keys) == 0 }

// Get is the value for key, and whether it's there.
func (m Map[V]) Get(key string) (V, bool) {
	v, ok := m.values[key]
	return v, ok
}

// Value is the value for key, or V's zero value.
func (m Map[V]) Value(key string) V { return m.values[key] }

// Has says whether key is in the map.
func (m Map[V]) Has(key string) bool {
	_, ok := m.values[key]
	return ok
}

// Set puts value under key: a new key goes last, an existing one keeps its place.
func (m *Map[V]) Set(key string, value V) {
	if m.values == nil {
		m.values = map[string]V{}
	}
	if _, ok := m.values[key]; !ok {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

// Delete removes key, if it's there.
func (m *Map[V]) Delete(key string) {
	if _, ok := m.values[key]; !ok {
		return
	}
	delete(m.values, key)
	m.keys = slices.DeleteFunc(slices.Clone(m.keys), func(k string) bool { return k == key })
}

// Keys is the keys, in order (a copy).
func (m Map[V]) Keys() []string { return slices.Clone(m.keys) }

// All iterates the entries in order.
func (m Map[V]) All() iter.Seq2[string, V] {
	return func(yield func(string, V) bool) {
		for _, k := range m.keys {
			if !yield(k, m.values[k]) {
				return
			}
		}
	}
}

// Values iterates the values in key order.
func (m Map[V]) Values() iter.Seq[V] {
	return func(yield func(V) bool) {
		for _, k := range m.keys {
			if !yield(m.values[k]) {
				return
			}
		}
	}
}

// Clone is a copy that shares nothing with m (the values themselves are copied shallowly).
func (m Map[V]) Clone() Map[V] {
	var out Map[V]
	for k, v := range m.All() {
		out.Set(k, v)
	}
	return out
}

// Plus is Kotlin's `m + other`: m's entries, then other's, other winning a
// key both have (in m's place).
func (m Map[V]) Plus(other Map[V]) Map[V] {
	out := m.Clone()
	for k, v := range other.All() {
		out.Set(k, v)
	}
	return out
}

// MapValues is the same keys, in order, with f applied to each value.
func MapValues[V, W any](m Map[V], f func(key string, value V) W) Map[W] {
	var out Map[W]
	for k, v := range m.All() {
		out.Set(k, f(k, v))
	}
	return out
}

// Sorted is m with its keys in name order.
func (m Map[V]) Sorted() Map[V] {
	keys := m.Keys()
	slices.Sort(keys)
	var out Map[V]
	for _, k := range keys {
		out.Set(k, m.values[k])
	}
	return out
}

// Ptr is a pointer to v, for the model's optional fields.
func Ptr[T any](v T) *T { return &v }

// distinct is xs without repeats, first occurrences in order.
func distinct(xs []string) []string {
	if xs == nil {
		return nil
	}
	seen := make(map[string]bool, len(xs))
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// Distinct is xs without repeats, first occurrences in order (Kotlin's distinct()).
func Distinct(xs []string) []string { return distinct(xs) }

// concat is a fresh slice holding every list's elements in order.
func concat[T any](lists ...[]T) []T {
	var out []T
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}
