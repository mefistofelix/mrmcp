use tauri::{webview::{PageLoadEvent, WebviewWindowBuilder}, WebviewUrl};

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let url = "https://example.com/".parse().expect("valid probe URL");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .on_navigation(|url| {
                    println!("RUN_NAV {url}");
                    true
                })
                .on_page_load(|_window, payload| {
                    println!("RUN_LOAD {:?} {}", payload.event(), payload.url());
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        std::process::exit(0);
                    }
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build Tauri run-loop probe");

    app.run(|_, _| {});
}
