/**
 * 교통대 꿀팁 가이드 - 맛집 제보용 구글폼 + 구글 시트 자동 생성 스크립트
 *
 * 사용법: script.google.com 에서 새 프로젝트를 만들고 이 코드를 붙여 넣은 뒤 setup 함수를 실행하세요.
 * 실행하면 내 구글 드라이브에 아래 두 파일이 생깁니다.
 *   1) 구글폼 "교통대 꿀팁 가이드 - 맛집 제보"
 *   2) 구글 시트 "교통대 맛집 제보" (응답 시트 + 승인 체크칸 + '승인됨' 탭)
 * 실행 기록(로그)에 앱 설정(js/config.js)에 넣을 값이 출력됩니다.
 */
function setup() {
  var FOODS = ['한식', '중식', '일식', '분식', '기타'];

  var form = FormApp.create('교통대 꿀팁 가이드 - 맛집 제보');
  form.setDescription('교통대 충주캠퍼스 학생이 아는 맛집을 알려 주세요. 관리자가 확인한 뒤 지도에 올라갑니다.\n이름·연락처 같은 개인정보는 적지 마세요.');
  form.setCollectEmail(false);
  try { form.setRequireLogin(false); } catch (e) { Logger.log('로그인 없이 제출 설정 실패(학교 관리자 설정일 수 있음): ' + e); }

  var items = {
    name:    form.addTextItem().setTitle('가게 이름').setRequired(true),
    address: form.addTextItem().setTitle('위치(주소)'),
    link:    form.addTextItem().setTitle('지도 링크(네이버/카카오)'),
    menu:    form.addTextItem().setTitle('대표 메뉴'),
    food:    form.addMultipleChoiceItem().setTitle('음식 종류').setChoiceValues(FOODS),
    reason:  form.addParagraphTextItem().setTitle('한 줄 추천'),
    lat:     form.addTextItem().setTitle('위도(앱이 자동 입력)'),
    lng:     form.addTextItem().setTitle('경도(앱이 자동 입력)')
  };

  var ss = SpreadsheetApp.create('교통대 맛집 제보');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();
  Utilities.sleep(3000);

  // 폼 응답이 들어오는 시트 찾기
  var resp = ss.getSheets().filter(function (s) { return s.getFormUrl(); })[0];
  if (!resp) { SpreadsheetApp.flush(); Utilities.sleep(3000); resp = ss.getSheets().filter(function (s) { return s.getFormUrl(); })[0]; }
  resp.setName('제보');
  var lastCol = resp.getLastColumn(); // 타임스탬프 + 질문 8개 = 9
  var approveCol = lastCol + 1;
  resp.getRange(1, approveCol).setValue('승인').setFontWeight('bold').setBackground('#fff2cc');
  resp.getRange(2, approveCol, 999, 1).insertCheckboxes();
  resp.setFrozenRows(1);

  // 승인된 줄만 모아 보여 주는 탭(앱이 이 탭만 읽는다)
  ['Sheet1', '시트1'].forEach(function (n) { var s = ss.getSheetByName(n); if (s && ss.getSheets().length > 1) ss.deleteSheet(s); });
  var ok = ss.insertSheet('승인됨');
  ok.getRange(1, 1, 1, 9).setValues([['time', 'name', 'address', 'link', 'menu', 'food', 'reason', 'lat', 'lng']]);
  var colLetter = String.fromCharCode(64 + approveCol);
  var lastLetter = String.fromCharCode(64 + lastCol);
  // 폼 응답이 들어올 때마다 줄이 끼워져 범위가 밀리므로 INDIRECT로 고정한다
  ok.getRange('A2').setFormula("=IFERROR(FILTER(INDIRECT(\"'제보'!A2:" + lastLetter + "\"), INDIRECT(\"'제보'!" + colLetter + "2:" + colLetter + "\")=TRUE), \"\")");
  ok.setFrozenRows(1);

  // 앱이 폼으로 바로 제출할 때 쓰는 entry 번호 알아내기(미리 채운 링크에서 읽음)
  var r = form.createResponse();
  Object.keys(items).forEach(function (k) {
    var it = items[k];
    r.withItemResponse(k === 'food' ? it.createResponse('기타') : it.createResponse('x'));
  });
  var pre = r.toPrefilledUrl();
  var entries = {}, i = 0, keys = Object.keys(items);
  pre.replace(/entry\.(\d+)=/g, function (_, id) { entries[keys[i++]] = 'entry.' + id; return _; });

  var config = {
    formAction: form.getPublishedUrl().replace(/\/viewform.*$/, '/formResponse'),
    entries: entries,
    approvedCsv: '(시트 > 파일 > 공유 > 웹에 게시 > 승인됨 탭 > CSV 로 만든 주소를 여기에)'
  };
  Logger.log('폼 주소: ' + form.getPublishedUrl());
  Logger.log('폼 편집: ' + form.getEditUrl());
  Logger.log('시트 주소: ' + ss.getUrl());
  Logger.log('앱 설정(js/config.js):\n' + JSON.stringify(config, null, 2));
}
