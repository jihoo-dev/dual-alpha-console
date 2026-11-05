const express = require('express');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const DART_API_KEY = process.env.DART_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// RSI 계산 헬퍼 함수
function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

// 딥바잉 스코어 계산 알고리즘 (0~100점)
function evaluateDipScore(drawdown, sma200Gap, rsi) {
  let score = 0;

  // 1. 최고점 대비 낙폭(ATH Drawdown) 가점 (최대 40점)
  // -5% -> 10점, -10% -> 20점, -15% -> 30점, -20% 이하 -> 40점
  if (drawdown <= -20) score += 40;
  else if (drawdown <= -15) score += 30;
  else if (drawdown <= -10) score += 20;
  else if (drawdown <= -5) score += 10;

  // 2. 200일 이평선 괴리율 (최대 30점)
  // 200일선 아래로 이탈할수록 강한 저점 신호
  if (sma200Gap <= -10) score += 30;
  else if (sma200Gap <= -5) score += 20;
  else if (sma200Gap <= 0) score += 10;

  // 3. RSI 14 과매도 구간 (최대 30점)
  // RSI 30 이하(극단적 과매도) -> 30점, 40 이하 -> 20점, 50 이하 -> 10점
  if (rsi <= 30) score += 30;
  else if (rsi <= 40) score += 20;
  else if (rsi <= 50) score += 10;

  return Math.min(100, Math.max(0, score));
}

// 미국 ETF 지표 데이터 API
app.get('/api/etf-radar', async (req, res) => {
  try {
    const symbols = ['QQQ', 'VOO'];
    const results = {};

    for (const symbol of symbols) {
      // 1년치 일봉 데이터 조회 (200일선 계산 목적)
      const historical = await yahooFinance.historical(symbol, {
        period1: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        interval: '1d',
      });

      const closes = historical.map(d => d.close);
      const currentPrice = closes[closes.length - 1];

      // 52주 최고가 및 낙폭 계산
      const high52Week = Math.max(...closes);
      const drawdown = ((currentPrice - high52Week) / high52Week) * 100;

      // 200일 이동평균선(SMA 200) 및 이격도 계산
      const recent200Closes = closes.slice(-200);
      const sma200 = recent200Closes.reduce((a, b) => a + b, 0) / recent200Closes.length;
      const sma200Gap = ((currentPrice - sma200) / sma200) * 100;

      // RSI(14) 계산
      const rsi = calculateRSI(closes, 14);

      // 복합 바닥 스코어 계산
      const dipScore = evaluateDipScore(drawdown, sma200Gap, rsi);

      results[symbol] = {
        currentPrice: currentPrice.toFixed(2),
        high52Week: high52Week.toFixed(2),
        drawdown: drawdown.toFixed(2),
        sma200: sma200.toFixed(2),
        sma200Gap: sma200Gap.toFixed(2),
        rsi,
        dipScore,
        lastUpdated: new Date().toLocaleTimeString('ko-KR')
      };
    }

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('ETF fetch error:', error);
    res.status(500).json({ success: false, message: 'ETF 시세 데이터를 불러오지 못했습니다.' });
  }
});

// 국내 DART 확정 이벤트 공시 API
app.get('/api/kr-events', async (req, res) => {
  try {
    if (!DART_API_KEY) {
      // DART_API_KEY 미설정 시 동작 확인용 데모 데이터 반환
      return res.json({
        success: true,
        source: 'DEMO',
        events: [
          {
            type: '공개매수',
            title: '[공개매수신고서] 한국앤컴퍼니 주식회사 (단기 차익거래 기회)',
            corpName: '한국앤컴퍼니',
            tenderPrice: '24,000원',
            currentEstimate: '22,800원',
            expectedYield: '+5.26%',
            date: new Date().toISOString().split('T')[0],
            isHot: true
          },
          {
            type: '소각결정',
            title: '[주요사항보고서] 자기주식 소각 결정 (보유 보통주 5% 전량 소각)',
            corpName: '메리츠금융지주',
            tenderPrice: '-',
            currentEstimate: '-',
            expectedYield: '익일 시초가 호재',
            date: new Date().toISOString().split('T')[0],
            isHot: false
          }
        ]
      });
    }

    // Open DART API 연동 (실제 호출)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_API_KEY}&bgn_de=${today}&page_no=1&page_count=50`;
    const response = await axios.get(url);

    let rawList = response.data.list || [];
    // 공개매수, 소각, 무상증자 등 확정성 이벤트 키워드 필터링
    const targetKeywords = ['공개매수', '주식소각', '감자결정', '합병결정'];
    const filtered = rawList.filter(item => 
      targetKeywords.some(k => item.report_nm.includes(k))
    ).map(item => ({
      type: item.report_nm.includes('공개매수') ? '공개매수' : '확정공시',
      title: item.report_nm,
      corpName: item.corp_name,
      tenderPrice: '공시 본문 참조',
      currentEstimate: '-',
      expectedYield: '분석 대기',
      date: item.rcept_dt,
      rceptNo: item.rcept_no,
      isHot: item.report_nm.includes('공개매수')
    }));

    res.json({ success: true, source: 'REAL_DART', events: filtered });
  } catch (error) {
    console.error('DART error:', error);
    res.status(500).json({ success: false, message: '공시 데이터를 조회하지 못했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`Dual-Alpha Console is running on port ${PORT}`);
});