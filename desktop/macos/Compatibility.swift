import AppKit
import WebKit
import SwiftUI

// Explicit compatibility surface for apps which publish only HTML/React modules.
// The launcher, Afterglow catalog/player and game runtime do not instantiate WebKit.
@MainActor final class CompatibilityBrowser: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    let web: WKWebView
    var edit: ((String, @escaping (String) -> Void) -> Void)?
    var error: ((String) -> Void)?
    @Published var title = ""
    private let origin: URL
    init(url: URL, token: String = "") {
        origin = url
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        if !token.isEmpty {
            let json = String(data: try! JSONSerialization.data(withJSONObject: [token]), encoding: .utf8)!
            let script = "if(location.origin === 'http://127.0.0.1:4777') localStorage.setItem('cyberdeck-token', \(json)[0]);"
            config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let scriptURL = Bundle.main.url(forResource: "controller", withExtension: "js")!
        let script = (try? String(contentsOf: scriptURL, encoding: .utf8)) ?? ""
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        web = WKWebView(frame: .zero, configuration: config)
        super.init(); web.navigationDelegate = self
        config.userContentController.add(self, name: "caseworkInput")
        web.load(URLRequest(url: url))
    }
    func close() { web.stopLoading(); web.loadHTMLString("", baseURL: nil); web.configuration.userContentController.removeScriptMessageHandler(forName: "caseworkInput") }
    func input(_ key: String) {
        let json = String(data: try! JSONSerialization.data(withJSONObject: [key]), encoding: .utf8)!
        web.evaluateJavaScript("window.caseworkRemote?.input(\(json)[0])", completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "caseworkInput", let body = message.body as? Object, string(body["type"]) == "edit" else { return }
        edit?(string(body["value"])) { [weak self] value in
            self?.web.callAsyncJavaScript("window.caseworkRemote?.text(value)", arguments: ["value": value], in: message.frameInfo, in: .page, completionHandler: nil)
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { title = webView.title ?? "Application"; input("focus") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError failure: Error) {
        if (failure as NSError).code != NSURLErrorCancelled { error?(failure.localizedDescription + " · B returns to Casework.") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if ["http", "https", "about", "blob"].contains(url.scheme ?? "") { decisionHandler(.allow) }
        else { decisionHandler(.cancel); if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) } }
    }
}
struct CompatibilityView: NSViewRepresentable {
    let browser: CompatibilityBrowser
    func makeNSView(context: Context) -> WKWebView { browser.web }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
