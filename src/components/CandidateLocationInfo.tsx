import React from 'react';

interface LocationInfoProps {
  location: {
    currentWorkLocation?: string | null;
    prefecture?: string | null;
    nearestStation?: string | null;
    availableRegions?: string[] | null;
    remoteAvailable?: boolean;
  };
  className?: string;
}

/**
 * 候補者のロケーション情報を表示するコンポーネント
 */
export const CandidateLocationInfo: React.FC<LocationInfoProps> = ({ location, className = "" }) => {
  const { currentWorkLocation, prefecture, nearestStation, availableRegions, remoteAvailable } = location;

  // 表示する拠点（現在地か都道府県）
  const displayLocation = currentWorkLocation || prefecture;

  if (!displayLocation && !availableRegions?.length && !remoteAvailable) {
    return null;
  }

  return (
    <div className={`flex flex-col gap-2 p-3 bg-white rounded-lg border border-slate-200 text-sm shadow-sm ${className}`}>
      <div className="flex items-center justify-between border-b border-slate-200 pb-1 mb-1">
        <span className="font-bold text-slate-700 flex items-center gap-1">
          📍 ロケーション
        </span>
        {remoteAvailable && (
          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[10px] font-black uppercase tracking-wider shadow-sm border border-emerald-200">
            Remote OK
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {displayLocation && (
          <div className="text-slate-600 flex items-baseline gap-1.5">
            <span className="text-slate-400 text-[10px] font-bold w-12 shrink-0 uppercase">Current</span>
            <span className="font-medium text-slate-800">{displayLocation}</span>
            {nearestStation && (
              <span className="text-slate-500 text-xs"> / {nearestStation}</span>
            )}
          </div>
        )}

        {availableRegions && availableRegions.length > 0 && (
          <div className="flex items-start gap-1.5">
            <span className="text-slate-400 text-[10px] font-bold w-12 shrink-0 mt-1 uppercase">Area</span>
            <div className="flex flex-wrap gap-1">
              {availableRegions.map((region, i) => (
                <span key={i} className="px-1.5 py-0.5 bg-white text-blue-600 rounded border border-blue-200 text-[11px] font-medium">
                  {region}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};