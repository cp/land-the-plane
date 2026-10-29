// Runway data from OurAirports (https://ourairports.com/data/).
// "le" / "he" are the low and high numbered ends of each runway.

export interface RunwayData {
  le: { ident: string; lat: number; lng: number };
  he: { ident: string; lat: number; lng: number };
  widthFt: number;
}

export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lng: number;
  elevationFt: number;
  runways: RunwayData[];
}

export const AIRPORTS: Airport[] = [
  {
    icao: 'KPDX',
    name: 'Portland International',
    lat: 45.588699,
    lng: -122.598,
    elevationFt: 31,
    runways: [
      {
        le: { ident: '10L', lat: 45.596537, lng: -122.600062 },
        he: { ident: '28R', lat: 45.583428, lng: -122.566444 },
        widthFt: 150,
      },
      {
        le: { ident: '10R', lat: 45.595155, lng: -122.62151 },
        he: { ident: '28L', lat: 45.580515, lng: -122.583901 },
        widthFt: 150,
      },
      {
        le: { ident: '3', lat: 45.582405, lng: -122.616856 },
        he: { ident: '21', lat: 45.594064, lng: -122.600255 },
        widthFt: 150,
      },
    ],
  },
];
