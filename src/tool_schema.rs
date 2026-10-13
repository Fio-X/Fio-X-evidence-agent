//! Second, independent check of tool arguments (agent-spec 10.3): the Node tool host converts and validates, then the Rust side re-checks
//! the normalized arguments with this validator before it lets the call run. Only the keywords the registered tools use are understood;
//! `unsupported_keywords` lists the rest so a schema this code cannot check is refused instead of silently passed. `pattern` is the one
//! keyword that is accepted but checked only by the host (no regular-expression crate is a dependency here).

use serde_json::Value;

const ANNOTATIONS: [&str; 6] = [
    "description",
    "title",
    "default",
    "examples",
    "$comment",
    "label",
];
const KNOWN: [&str; 17] = [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
];

pub fn unsupported_keywords(schema: &Value, path: &str, out: &mut Vec<String>) {
    let Some(map) = schema.as_object() else {
        return;
    };
    for key in map.keys() {
        if key != "pattern"
            && !KNOWN.contains(&key.as_str())
            && !ANNOTATIONS.contains(&key.as_str())
        {
            out.push(format!("{path}: {key}"));
        }
    }
    if let Some(props) = map.get("properties").and_then(Value::as_object) {
        for (name, sub) in props {
            let here = if path == "root" {
                name.clone()
            } else {
                format!("{path}.{name}")
            };
            unsupported_keywords(sub, &here, out);
        }
    }
    if let Some(items) = map.get("items") {
        unsupported_keywords(items, &format!("{path}[]"), out);
    }
    if let Some(branches) = map.get("anyOf").and_then(Value::as_array) {
        for (i, sub) in branches.iter().enumerate() {
            unsupported_keywords(sub, &format!("{path}|{i}"), out);
        }
    }
    if let Some(extra) = map.get("additionalProperties").filter(|v| v.is_object()) {
        unsupported_keywords(extra, &format!("{path}{{}}"), out);
    }
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_integer(value: &Value) -> bool {
    value.as_i64().is_some()
        || value.as_u64().is_some()
        || value.as_f64().is_some_and(|f| f.fract() == 0.0)
}

fn matches_type(schema: &Value, value: &Value) -> bool {
    let types: Vec<&str> = match schema.get("type") {
        None => return true,
        Some(Value::String(t)) => vec![t.as_str()],
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
        Some(_) => return false,
    };
    let kind = kind_of(value);
    types
        .iter()
        .any(|t| *t == kind || (*t == "integer" && kind == "number" && is_integer(value)))
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// Validation errors as (path, message); empty when the value fits. Same order and wording as the host's validator.
pub fn validate(schema: &Value, value: &Value, path: &str) -> Vec<(String, String)> {
    let here = if path.is_empty() {
        "root".to_string()
    } else {
        path.to_string()
    };
    let mut errors = Vec::new();
    let Some(map) = schema.as_object() else {
        return errors;
    };
    if let Some(branches) = map.get("anyOf").and_then(Value::as_array) {
        if !branches
            .iter()
            .any(|sub| validate(sub, value, path).is_empty())
        {
            errors.push((here, "Expected union value".to_string()));
        }
        return errors;
    }
    if let Some(expected) = map.get("const") {
        if expected != value {
            errors.push((here.clone(), format!("Expected {expected}")));
        }
    }
    if let Some(options) = map.get("enum").and_then(Value::as_array) {
        if !options.iter().any(|option| option == value) {
            let list: Vec<String> = options.iter().map(Value::to_string).collect();
            errors.push((here.clone(), format!("Expected one of {}", list.join(", "))));
        }
    }
    if !matches_type(schema, value) {
        let wanted = match map.get("type") {
            Some(Value::Array(list)) => list
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" or "),
            Some(Value::String(t)) => t.clone(),
            _ => String::new(),
        };
        errors.push((here, format!("Expected {wanted}")));
        return errors;
    }
    if let Some(n) = value.as_f64().filter(|_| value.is_number()) {
        let bound = |key: &str| map.get(key).and_then(Value::as_f64);
        if bound("minimum").is_some_and(|b| n < b) {
            errors.push((
                here.clone(),
                format!("Expected number >= {}", map["minimum"]),
            ));
        }
        if bound("maximum").is_some_and(|b| n > b) {
            errors.push((
                here.clone(),
                format!("Expected number <= {}", map["maximum"]),
            ));
        }
        if bound("exclusiveMinimum").is_some_and(|b| n <= b) {
            errors.push((
                here.clone(),
                format!("Expected number > {}", map["exclusiveMinimum"]),
            ));
        }
        if bound("exclusiveMaximum").is_some_and(|b| n >= b) {
            errors.push((
                here.clone(),
                format!("Expected number < {}", map["exclusiveMaximum"]),
            ));
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.encode_utf16().count() as u64;
        if map
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|b| length < b)
        {
            errors.push((
                here.clone(),
                format!("Expected string length >= {}", map["minLength"]),
            ));
        }
        if map
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|b| length > b)
        {
            errors.push((
                here.clone(),
                format!("Expected string length <= {}", map["maxLength"]),
            ));
        }
    }
    if let Some(list) = value.as_array() {
        let length = list.len() as u64;
        if map
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|b| length < b)
        {
            errors.push((
                here.clone(),
                format!("Expected array length >= {}", map["minItems"]),
            ));
        }
        if map
            .get("maxItems")
            .and_then(Value::as_u64)
            .is_some_and(|b| length > b)
        {
            errors.push((
                here.clone(),
                format!("Expected array length <= {}", map["maxItems"]),
            ));
        }
        if map.get("uniqueItems") == Some(&Value::Bool(true)) {
            let mut seen: Vec<&Value> = Vec::new();
            let mut duplicate = false;
            for item in list {
                if seen.contains(&item) {
                    duplicate = true;
                }
                seen.push(item);
            }
            if duplicate {
                errors.push((
                    here.clone(),
                    "Expected array items to be unique".to_string(),
                ));
            }
        }
        if let Some(items) = map.get("items") {
            for (i, item) in list.iter().enumerate() {
                errors.extend(validate(items, item, &join(path, &i.to_string())));
            }
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = map.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    errors.push((join(path, key), "Expected required property".to_string()));
                }
            }
        }
        let props = map.get("properties").and_then(Value::as_object);
        if let Some(props) = props {
            for (key, sub) in props {
                if let Some(inner) = object.get(key) {
                    errors.extend(validate(sub, inner, &join(path, key)));
                }
            }
        }
        let extra = object
            .keys()
            .filter(|key| !props.is_some_and(|p| p.contains_key(*key)));
        match map.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                for key in extra {
                    errors.push((join(path, key), "Unexpected property".to_string()));
                }
            }
            Some(sub) if sub.is_object() => {
                for key in extra {
                    errors.extend(validate(sub, &object[key], &join(path, key)));
                }
            }
            _ => {}
        }
    }
    errors
}

/// The fixed error text a failed argument check returns to the model (agent-spec 10.3). Object keys print sorted (serde_json without
/// `preserve_order`); the host's own text keeps the model's key order, and only that one is normally seen.
pub fn failure_text(name: &str, errors: &[(String, String)], received: &Value) -> String {
    let lines: Vec<String> = errors
        .iter()
        .map(|(path, message)| format!("  - {path}: {message}"))
        .collect();
    let shown = serde_json::to_string_pretty(received).unwrap_or_default();
    format!(
        "Tool \"{name}\" rejected its arguments:\n{}\n\nArguments as sent:\n{shown}",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({"type":"object","properties":{
            "n":{"type":"number"},"i":{"type":"integer","minimum":1},"b":{"type":"boolean"},"s":{"type":"string","maxLength":3},
            "e":{"type":"string","enum":["a","b"]},"list":{"type":"array","items":{"type":"number"},"maxItems":2,"uniqueItems":true},
            "u":{"anyOf":[{"type":"string"},{"type":"number"}]}},
            "required":["n","i","b","s"],"additionalProperties":false})
    }

    #[test]
    fn a_fitting_value_has_no_errors() {
        let ok = json!({"n":1.5,"i":2,"b":true,"s":"abc","e":"a","list":[1,2],"u":3});
        assert!(validate(&schema(), &ok, "").is_empty());
    }

    #[test]
    fn each_rule_reports_its_own_error() {
        let cases = [
            (
                json!({"i":1,"b":true,"s":"x"}),
                "n: Expected required property",
            ),
            (
                json!({"n":"x","i":1,"b":true,"s":"x"}),
                "n: Expected number",
            ),
            (
                json!({"n":1,"i":0,"b":true,"s":"x"}),
                "i: Expected number >= 1",
            ),
            (
                json!({"n":1,"i":1.5,"b":true,"s":"x"}),
                "i: Expected integer",
            ),
            (
                json!({"n":1,"i":1,"b":true,"s":"abcd"}),
                "s: Expected string length <= 3",
            ),
            (
                json!({"n":1,"i":1,"b":true,"s":"x","e":"z"}),
                "e: Expected one of \"a\", \"b\"",
            ),
            (
                json!({"n":1,"i":1,"b":true,"s":"x","list":[1,1]}),
                "list: Expected array items to be unique",
            ),
            (
                json!({"n":1,"i":1,"b":true,"s":"x","list":["q"]}),
                "list.0: Expected number",
            ),
            (
                json!({"n":1,"i":1,"b":true,"s":"x","u":true}),
                "u: Expected union value",
            ),
            (
                json!({"n":1,"i":1,"b":true,"s":"x","zz":1}),
                "zz: Unexpected property",
            ),
        ];
        for (value, expected) in cases {
            let errors = validate(&schema(), &value, "");
            let lines: Vec<String> = errors.iter().map(|(p, m)| format!("{p}: {m}")).collect();
            assert!(
                lines.iter().any(|l| l == expected),
                "{value}: wanted {expected}, got {lines:?}"
            );
        }
    }

    #[test]
    fn failure_text_has_the_fixed_shape_with_keys_sorted() {
        let received = json!({"n":"x","i":1,"b":true});
        let errors = validate(&schema(), &received, "");
        assert_eq!(
            failure_text("t", &errors, &received),
            "Tool \"t\" rejected its arguments:\n  - s: Expected required property\n  - n: Expected number\n\nArguments as sent:\n{\n  \"b\": true,\n  \"i\": 1,\n  \"n\": \"x\"\n}"
        );
    }

    #[test]
    fn an_unchecked_keyword_is_listed_and_pattern_is_host_only() {
        let mut out = Vec::new();
        unsupported_keywords(
            &json!({"type":"object","properties":{"a":{"type":"string","format":"date","pattern":"x"}}}),
            "root",
            &mut out,
        );
        assert_eq!(out, vec!["a: format".to_string()]);
    }
}
