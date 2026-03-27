const BASE_URL = 'https://api.startmessaging.com';

interface LanguageExamples {
  curl: string;
  nodejs: string;
  python: string;
  php: string;
  java: string;
  go: string;
}

interface EndpointExample {
  title: string;
  description: string;
  endpoint: string;
  languages: LanguageExamples;
}

interface UsageGuideResponse {
  baseUrl: string;
  authentication: { header: string; description: string };
  examples: Record<string, EndpointExample>;
}

function generateSendOtpExamples(apiKey: string): LanguageExamples {
  return {
    curl: `curl -X POST ${BASE_URL}/otp/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${apiKey}" \\
  -d '{
    "phoneNumber": "+919876543210",
    "templateId": "TEMPLATE_ID",
    "variables": { "otp": "123456", "appName": "YourApp" }
  }'`,

    nodejs: `const response = await fetch('${BASE_URL}/otp/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': '${apiKey}',
  },
  body: JSON.stringify({
    phoneNumber: '+919876543210',
    templateId: 'TEMPLATE_ID',
    variables: { otp: '123456', appName: 'YourApp' },
  }),
});
const data = await response.json();`,

    python: `import requests

response = requests.post(
    "${BASE_URL}/otp/send",
    headers={
        "Content-Type": "application/json",
        "X-API-Key": "${apiKey}",
    },
    json={
        "phoneNumber": "+919876543210",
        "templateId": "TEMPLATE_ID",
        "variables": {"otp": "123456", "appName": "YourApp"},
    },
)
data = response.json()`,

    php: `$ch = curl_init('${BASE_URL}/otp/send');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-API-Key: ${apiKey}',
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'phoneNumber' => '+919876543210',
        'templateId' => 'TEMPLATE_ID',
        'variables' => ['otp' => '123456', 'appName' => 'YourApp'],
    ]),
]);
$response = curl_exec($ch);
$data = json_decode($response, true);
curl_close($ch);`,

    java: `HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("${BASE_URL}/otp/send"))
    .header("Content-Type", "application/json")
    .header("X-API-Key", "${apiKey}")
    .POST(HttpRequest.BodyPublishers.ofString(
        "{\\"phoneNumber\\":\\"+919876543210\\",\\"templateId\\":\\"TEMPLATE_ID\\",\\"variables\\":{\\"otp\\":\\"123456\\",\\"appName\\":\\"YourApp\\"}}"
    ))
    .build();
HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());`,

    go: `body := bytes.NewBufferString(\`{"phoneNumber":"+919876543210","templateId":"TEMPLATE_ID","variables":{"otp":"123456","appName":"YourApp"}}\`)
req, _ := http.NewRequest("POST", "${BASE_URL}/otp/send", body)
req.Header.Set("Content-Type", "application/json")
req.Header.Set("X-API-Key", "${apiKey}")
resp, _ := http.DefaultClient.Do(req)
defer resp.Body.Close()`,
  };
}

function generateUsageGuide(apiKey: string): UsageGuideResponse {
  return {
    baseUrl: BASE_URL,
    authentication: {
      header: 'X-API-Key',
      description:
        'Include your API key in the X-API-Key header with every request. You can create API keys from the dashboard or via POST /api-keys.',
    },
    examples: {
      sendOtp: {
        title: 'Send OTP',
        description:
          'Send a one-time password to a phone number. Fields: phoneNumber (E.164 format), templateId (optional), and variables (Must contain "otp" — a 4-6 digit code you generate, plus optional custom placeholders like "appName").',
        endpoint: 'POST /otp/send',
        languages: generateSendOtpExamples(apiKey),
      },
    },
  };
}

export { generateUsageGuide, generateSendOtpExamples };
export type { LanguageExamples, UsageGuideResponse };
