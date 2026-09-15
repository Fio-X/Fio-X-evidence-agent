const INVESTIGATE_TEMPLATE: &str = include_str!("../prompts/investigate.md");

pub fn investigation(topic: &str, local_data: &[String]) -> String {
    let mut prompt = INVESTIGATE_TEMPLATE.replace("{{TOPIC}}", topic);
    if !local_data.is_empty() {
        prompt.push_str("\nUser-supplied local data already available inside this investigation:\n");
        for path in local_data {
            prompt.push_str(&format!("- {path}\n"));
        }
        prompt.push_str("Use artifact_inventory if you need to inspect available files before querying them. Treat local files as evidence inputs and profile their schema before drawing conclusions.\n");
    }
    prompt
}
